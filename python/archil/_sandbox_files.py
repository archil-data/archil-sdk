from __future__ import annotations

import asyncio
import os
from os import PathLike
from pathlib import Path, PurePosixPath
from typing import Any, Optional, Union
from uuid import uuid4

from ._models import SandboxProcessOutput, SandboxProcessResult
from ._sandbox_process import _SandboxProcess
from .errors import SandboxFileTransferError


_UPLOAD_CHUNK_BYTES = 1024 * 1024
_DOWNLOAD_CHUNK_BYTES = 512 * 1024

_UPLOAD_COMMAND = """set -eu
mkdir -p "$ARCHIL_FILE_PARENT"
trap 'rm -f "$ARCHIL_FILE_TEMP"' EXIT HUP INT TERM
: > "$ARCHIL_FILE_TEMP"
cat > "$ARCHIL_FILE_TEMP"
chmod "$ARCHIL_FILE_MODE" "$ARCHIL_FILE_TEMP"
mv -f "$ARCHIL_FILE_TEMP" "$ARCHIL_FILE_TARGET"
trap - EXIT HUP INT TERM"""

_DOWNLOAD_COMMAND = """set -eu
trap 'rm -f "$ARCHIL_FILE_TEMP"' EXIT HUP INT TERM
exec 3< "$ARCHIL_FILE_PATH"
while IFS= read -r count; do
    dd bs="$count" count=1 <&3 > "$ARCHIL_FILE_TEMP" 2>/dev/null
    size=$(wc -c < "$ARCHIL_FILE_TEMP")
    printf '%s\n' "$size"
    cat "$ARCHIL_FILE_TEMP"
    [ "$size" -eq "$count" ] || break
done"""


class _ProcessOutputReader:
    def __init__(self) -> None:
        self._exit_task: Optional[asyncio.Task[SandboxProcessResult]] = None
        self._chunks: asyncio.Queue[Union[bytes, BaseException]] = asyncio.Queue()
        self._buffer = bytearray()
        self._stderr = bytearray()
        self._cursor = 0

    def feed(self, output: SandboxProcessOutput) -> None:
        if output.offset != self._cursor:
            self._chunks.put_nowait(
                RuntimeError(
                    f"Sandbox process output gap: expected offset {self._cursor}, "
                    f"received {output.offset}"
                )
            )
            return
        self._cursor += len(output.data)
        if output.stream == "stdout":
            self._chunks.put_nowait(output.data)
        else:
            self._stderr.extend(output.data)

    def attach(self, process: _SandboxProcess) -> None:
        self._exit_task = asyncio.create_task(process.wait())

    async def read_line(self) -> bytes:
        while True:
            newline = self._buffer.find(b"\n")
            if newline >= 0:
                line = bytes(self._buffer[:newline])
                del self._buffer[: newline + 1]
                return line
            self._buffer.extend(await self._next_chunk())

    async def read(self, size: int) -> bytes:
        while len(self._buffer) < size:
            self._buffer.extend(await self._next_chunk())
        data = bytes(self._buffer[:size])
        del self._buffer[:size]
        return data

    async def wait(self) -> None:
        if self._exit_task is None:
            raise RuntimeError("File transfer process has not started")
        _raise_for_result(await self._exit_task, self._stderr.decode(errors="replace"))

    async def close(self) -> None:
        if self._exit_task is not None:
            await asyncio.gather(self._exit_task, return_exceptions=True)

    async def _next_chunk(self) -> bytes:
        if not self._chunks.empty():
            return self._unwrap(self._chunks.get_nowait())
        if self._exit_task is None:
            raise RuntimeError("File transfer process has not started")

        chunk_task = asyncio.create_task(self._chunks.get())
        done, _ = await asyncio.wait(
            (chunk_task, self._exit_task),
            return_when=asyncio.FIRST_COMPLETED,
        )
        if chunk_task in done:
            return self._unwrap(chunk_task.result())

        chunk_task.cancel()
        await asyncio.gather(chunk_task, return_exceptions=True)
        _raise_for_result(self._exit_task.result(), self._stderr.decode(errors="replace"))
        raise RuntimeError("Sandbox process exited before file transfer completed")

    @staticmethod
    def _unwrap(item: Union[bytes, BaseException]) -> bytes:
        if isinstance(item, BaseException):
            raise item
        return item


class _SandboxFiles:
    def __init__(self, sandbox: Any) -> None:
        self._sandbox = sandbox

    async def upload_file(
        self,
        local_path: Union[str, PathLike],
        remote_path: str,
        *,
        mode: Optional[int] = None,
    ) -> None:
        source = Path(local_path)
        remote = _remote_file_path(remote_path)
        file_mode = source.stat().st_mode & 0o777 if mode is None else mode
        if not 0 <= file_mode <= 0o7777:
            raise ValueError("mode must be between 0 and 0o7777")

        temporary = str(remote.parent / f".archil-upload-{uuid4().hex}")
        process: Optional[_SandboxProcess] = None
        try:
            transfer: _SandboxProcess = await self._sandbox.processes.start(
                _UPLOAD_COMMAND,
                env={
                    "ARCHIL_FILE_PARENT": str(remote.parent),
                    "ARCHIL_FILE_TARGET": str(remote),
                    "ARCHIL_FILE_TEMP": temporary,
                    "ARCHIL_FILE_MODE": f"{file_mode:o}",
                },
            )
            process = transfer
            with source.open("rb") as file:
                while chunk := await asyncio.to_thread(file.read, _UPLOAD_CHUNK_BYTES):
                    await transfer.send_input(chunk)
            await transfer.close_stdin()
            _raise_for_result(await transfer.wait())
        except Exception as exc:
            if process is not None:
                await _abort(process)
            if isinstance(exc, (FileNotFoundError, IsADirectoryError, PermissionError, ValueError)):
                raise
            raise SandboxFileTransferError("upload", str(remote), str(exc)) from exc
        finally:
            if process is not None:
                await process.disconnect()

    async def download_file(
        self,
        remote_path: str,
        local_path: Union[str, PathLike],
    ) -> None:
        remote = _remote_file_path(remote_path)
        target = Path(local_path)
        if not target.name:
            raise ValueError("local_path must identify a file")
        await asyncio.to_thread(target.parent.mkdir, parents=True, exist_ok=True)
        temporary = target.parent / f".{target.name}.archil-download-{uuid4().hex}"
        reader = _ProcessOutputReader()
        process: Optional[_SandboxProcess] = None
        try:
            transfer: _SandboxProcess = await self._sandbox.processes.start(
                _DOWNLOAD_COMMAND,
                env={
                    "ARCHIL_FILE_PATH": str(remote),
                    "ARCHIL_FILE_TEMP": f"/tmp/.archil-download-{uuid4().hex}",
                },
                on_output=reader.feed,
                collect_output=False,
            )
            process = transfer
            reader.attach(transfer)
            with temporary.open("xb") as file:
                while True:
                    await transfer.send_input(f"{_DOWNLOAD_CHUNK_BYTES}\n")
                    size_line = await reader.read_line()
                    try:
                        size = int(size_line.strip())
                    except ValueError as exc:
                        raise RuntimeError(f"Sandbox returned an invalid chunk size: {size_line!r}") from exc
                    if not 0 <= size <= _DOWNLOAD_CHUNK_BYTES:
                        raise RuntimeError(f"Sandbox returned an invalid chunk size: {size}")
                    if size == 0:
                        break
                    data = await reader.read(size)
                    await asyncio.to_thread(file.write, data)
                    if size < _DOWNLOAD_CHUNK_BYTES:
                        break
                await asyncio.to_thread(_flush_and_sync, file)
            await reader.wait()
            await asyncio.to_thread(os.replace, temporary, target)
        except Exception as exc:
            if process is not None:
                await _abort(process)
            if isinstance(exc, (FileNotFoundError, IsADirectoryError, PermissionError, ValueError)):
                raise
            raise SandboxFileTransferError("download", str(remote), str(exc)) from exc
        finally:
            if process is not None:
                await process.disconnect()
            await reader.close()
            await asyncio.to_thread(temporary.unlink, missing_ok=True)


def _raise_for_result(result: SandboxProcessResult, stderr: Optional[str] = None) -> None:
    if result.status == "completed" and result.exit_code == 0:
        return
    detail = (
        (result.stderr if stderr is None else stderr).strip()
        or result.exit_reason
        or f"exit code {result.exit_code}"
    )
    raise RuntimeError(detail)


async def _abort(process: _SandboxProcess) -> None:
    try:
        await process.kill()
    except (ConnectionError, RuntimeError):
        pass


def _remote_file_path(path: str) -> PurePosixPath:
    if "\0" in path:
        raise ValueError("remote path cannot contain NUL")
    remote = PurePosixPath(path)
    if not remote.is_absolute() or not remote.name:
        raise ValueError("remote path must be an absolute file path")
    return remote


def _flush_and_sync(file) -> None:
    file.flush()
    os.fsync(file.fileno())
