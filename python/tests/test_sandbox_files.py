from __future__ import annotations

import asyncio
import os
import subprocess
import time
from pathlib import Path

import pytest

from archil import SandboxFiles
from archil._models import SandboxProcessOutput, SandboxProcessResult
from archil._sandbox_files import _DOWNLOAD_COMMAND, _UPLOAD_COMMAND, _SandboxFiles
from archil.errors import SandboxFileTransferError
from conftest import ok_envelope


def sandbox_json() -> dict:
    return {
        "sandbox_id": "sbx-1",
        "name": "files-test",
        "status": "running",
        "vcpu_count": 1,
        "mem_size_mib": 2048,
        "base_image": "alpine:3.23",
        "max_ttl_seconds": 3600,
        "max_concurrent_execs": 4,
        "created_at": "2026-08-17T12:00:00Z",
        "running_at": "2026-08-17T12:00:00Z",
        "last_active_at": "2026-08-17T12:00:00Z",
    }


class FakeProcess:
    def __init__(self, command, env, on_output, collect_output, content, gap) -> None:
        self.command = command
        self.env = env
        self.on_output = on_output
        self.collect_output = collect_output
        self.content = content
        self.gap = gap
        self.input: list[str | bytes] = []
        self.position = 0
        self.cursor = 0
        self.killed = False
        self.disconnected = False
        self.result = asyncio.get_running_loop().create_future()

    async def send_input(self, data) -> None:
        self.input.append(data)
        if self.command != _DOWNLOAD_COMMAND:
            return
        count = int(data)
        chunk = self.content[self.position : self.position + count]
        size = f"{len(chunk)}\n".encode()
        self.on_output(
            SandboxProcessOutput("stdout", self.cursor + (1 if self.gap else 0), size)
        )
        self.cursor += len(size)
        midpoint = max(1, len(chunk) // 2)
        for part in (chunk[:midpoint], chunk[midpoint:]):
            if part:
                self.on_output(SandboxProcessOutput("stdout", self.cursor, part))
                self.cursor += len(part)
        self.position += len(chunk)
        if len(chunk) < count and not self.result.done():
            self.result.set_result(
                SandboxProcessResult(
                    status="completed",
                    exit_code=0,
                    stdout="",
                    stderr="",
                )
            )

    async def close_stdin(self) -> None:
        if not self.result.done():
            self.result.set_result(
                SandboxProcessResult(
                    status="completed",
                    exit_code=0,
                    stdout="",
                    stderr="",
                )
            )

    async def wait(self) -> SandboxProcessResult:
        return await self.result

    async def kill(self) -> SandboxProcessResult:
        self.killed = True
        if not self.result.done():
            self.result.set_result(
                SandboxProcessResult(
                    status="cancelled",
                    exit_reason="process killed",
                    stdout="",
                    stderr="",
                )
            )
        return await self.result

    async def disconnect(self) -> None:
        self.disconnected = True


class FakeSandbox:
    def __init__(self, content: bytes = b"", gap: bool = False) -> None:
        self.content = content
        self.gap = gap
        self.started: list[FakeProcess] = []

    async def run(self, command, *, env, on_output=None, collect_output=True):
        process = FakeProcess(
            command,
            env,
            on_output,
            collect_output,
            self.content,
            self.gap,
        )
        self.started.append(process)
        return process


def test_sandbox_exposes_public_files_namespace(archil, router):
    router.set(lambda _request: ok_envelope(sandbox_json()))

    assert isinstance(archil.sandboxes.get("sbx-1").files, SandboxFiles)


@pytest.mark.asyncio
async def test_upload_streams_through_process_api(tmp_path):
    content = bytes(range(256)) * 4097
    source = tmp_path / "source.bin"
    source.write_bytes(content)
    source.chmod(0o640)
    sandbox = FakeSandbox()

    await _SandboxFiles(sandbox).upload_file(source, "/workspace/source.bin")

    process = sandbox.started[0]
    assert b"".join(process.input) == content
    assert all(len(chunk) <= 1024 * 1024 for chunk in process.input)
    assert process.env["ARCHIL_FILE_TARGET"] == "/workspace/source.bin"
    assert process.env["ARCHIL_FILE_PARENT"] == "/workspace"
    assert process.env["ARCHIL_FILE_MODE"] == "640"
    assert process.disconnected


@pytest.mark.asyncio
async def test_download_streams_bounded_ranges_and_replaces_target(tmp_path, monkeypatch):
    content = b"\x00one\xfftwo\n"
    sandbox = FakeSandbox(content)
    monkeypatch.setattr("archil._sandbox_files._DOWNLOAD_CHUNK_BYTES", 4)
    target = tmp_path / "nested" / "result.bin"
    target.parent.mkdir()
    target.write_bytes(b"old")

    await _SandboxFiles(sandbox).download_file("/workspace/result.bin", target)

    process = sandbox.started[0]
    assert target.read_bytes() == content
    assert process.input == ["4\n", "4\n", "4\n"]
    assert process.env["ARCHIL_FILE_PATH"] == "/workspace/result.bin"
    assert not process.collect_output
    assert process.disconnected
    assert list(target.parent.glob("*.archil-download-*")) == []


@pytest.mark.asyncio
async def test_download_reads_zero_length_chunk_after_exact_multiple(tmp_path, monkeypatch):
    sandbox = FakeSandbox(b"12345678")
    monkeypatch.setattr("archil._sandbox_files._DOWNLOAD_CHUNK_BYTES", 4)
    target = tmp_path / "result.bin"

    await _SandboxFiles(sandbox).download_file("/workspace/result.bin", target)

    assert target.read_bytes() == b"12345678"
    assert sandbox.started[0].input == ["4\n", "4\n", "4\n"]


@pytest.mark.asyncio
async def test_download_detects_output_gap_without_replacing_target(tmp_path):
    sandbox = FakeSandbox(b"new", gap=True)
    target = tmp_path / "result.bin"
    target.write_bytes(b"old")

    with pytest.raises(SandboxFileTransferError, match="output gap"):
        await _SandboxFiles(sandbox).download_file("/workspace/result.bin", target)

    process = sandbox.started[0]
    assert target.read_bytes() == b"old"
    assert process.killed
    assert process.disconnected


@pytest.mark.asyncio
async def test_file_paths_must_be_absolute(tmp_path):
    source = tmp_path / "source"
    source.write_bytes(b"data")
    files = _SandboxFiles(FakeSandbox())

    with pytest.raises(ValueError, match="absolute file path"):
        await files.upload_file(source, "relative/path")
    with pytest.raises(ValueError, match="absolute file path"):
        await files.download_file("/", tmp_path / "target")


def _private(path: Path) -> bool:
    return path.stat().st_mode & 0o077 == 0


def _wait_for(directory: Path, pattern: str) -> Path:
    for _ in range(300):
        matches = list(directory.glob(pattern)) if directory.exists() else []
        if matches:
            return matches[0]
        time.sleep(0.01)
    raise AssertionError(f"no {pattern} appeared in {directory}")


def test_upload_script_keeps_its_temp_file_private(tmp_path):
    parent = tmp_path / "tests"
    env = {
        **os.environ,
        "ARCHIL_FILE_PARENT": str(parent),
        "ARCHIL_FILE_TARGET": str(parent / "hidden.py"),
        "ARCHIL_FILE_MODE": "644",
    }
    with subprocess.Popen(["sh", "-c", _UPLOAD_COMMAND], stdin=subprocess.PIPE, env=env) as child:
        try:
            child.stdin.write(b"assert solve() == 42\n")
            child.stdin.flush()
            assert _private(_wait_for(parent, ".archil-upload.*"))
            child.stdin.close()
            assert child.wait(timeout=10) == 0
        finally:
            child.kill()

    assert (parent / "hidden.py").read_text() == "assert solve() == 42\n"
    assert [path.name for path in parent.iterdir()] == ["hidden.py"]


def test_download_script_never_leaves_readable_chunks(tmp_path):
    source = tmp_path / "answers.txt"
    source.write_text("secret")
    temps = tmp_path / "tmp"
    temps.mkdir()
    env = {**os.environ, "ARCHIL_FILE_PATH": str(source), "TMPDIR": str(temps)}
    with subprocess.Popen(
        ["sh", "-c", _DOWNLOAD_COMMAND], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env
    ) as child:
        try:
            child.stdin.write(b"3\n")
            child.stdin.flush()
            assert child.stdout.readline().strip() == b"3"
            assert child.stdout.read(3) == b"sec"
            assert _private(_wait_for(temps, ".archil-download.*"))
        finally:
            child.kill()

    assert all(_private(path) for path in temps.iterdir())
