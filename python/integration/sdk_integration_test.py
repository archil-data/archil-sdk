#!/usr/bin/env python3
"""SDK integration test: disk and sandbox lifecycles plus the S3-compatible
object API through the real controlplane + fshandler stack.

This is the Python counterpart to integration-tests/node-e2e/sdk-integration-test.mjs.
The Node test additionally mounts the disk via the native FUSE binding
(@archildata/native); Python has no such binding.

Environment variables:
  ARCHIL_API_KEY        API key for the test/staging account
  ARCHIL_REGION         Fleet region (e.g. "test.us-east-1.red")
  ARCHIL_BASE_URL       Test/staging control-plane URL
  ARCHIL_S3_BASE_URL    Test/staging S3-compatible gateway URL
"""

from __future__ import annotations

import asyncio
import os
import sys
import tempfile
import time
import uuid
from pathlib import Path

from archil import Archil, ArchilError, ArchilS3Error, SandboxTerminal, TokenUser


def require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        print(f"Missing required environment variable: {name}", file=sys.stderr)
        sys.exit(1)
    return value


def step(label: str):
    class _Step:
        def __enter__(self):
            sys.stdout.write(f"{label}... ")
            sys.stdout.flush()

        def __exit__(self, exc_type, exc, tb):
            print("FAILED" if exc_type else "ok")
            return False

    return _Step()


def assert_that(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def delete_sandbox(sandbox, timeout_seconds: float = 30.0) -> None:
    deadline = time.monotonic() + timeout_seconds
    while True:
        try:
            sandbox.delete()
            return
        except ArchilError as err:
            if "dependent forks" not in str(err) or time.monotonic() >= deadline:
                raise
            time.sleep(0.5)


def run_sandbox_suite(archil) -> None:
    print("\n--- Persistent sandbox API ---")
    sandbox_ids: list[str] = []
    try:
        with step("Create sandbox"):
            sandbox = archil.sandboxes.create(
                name=f"sdk-py-sandbox-{uuid.uuid4().hex[:12]}",
                max_ttl_seconds=600,
            )
            sandbox_ids.append(sandbox.id)
            assert_that(
                sandbox.status == "running",
                f"unexpected sandbox status: {sandbox.status}",
            )

        with step("Verify sandbox in list"):
            sandboxes = archil.sandboxes.list()
            assert_that(
                any(item.id == sandbox.id for item in sandboxes),
                f"sandbox {sandbox.id} not found in list",
            )

        with step("Execute command in sandbox"):
            result = sandbox.exec("printf sandbox-ready")
            assert_that(result.exit_code == 0, f"sandbox exec failed: {result.stderr}")
            assert_that(
                result.stdout == "sandbox-ready",
                f"unexpected sandbox stdout: {result.stdout!r}",
            )

        with step("Stream a large binary file through the sandbox"):
            payload = bytes(range(256)) * 10_241
            with tempfile.TemporaryDirectory(prefix="archil-sdk-files-") as temp_dir:
                source = Path(temp_dir) / "source.bin"
                downloaded = Path(temp_dir) / "downloaded.bin"
                source.write_bytes(payload)
                source.chmod(0o640)
                sandbox.files.upload_file(source, "/tmp/sdk-source.bin")
                sandbox.files.download_file("/tmp/sdk-source.bin", downloaded)
                assert_that(downloaded.read_bytes() == payload, "sandbox file transfer mismatch")
                mode = sandbox.exec("stat -c %a /tmp/sdk-source.bin")
                assert_that(mode.stdout == "640\n", f"unexpected uploaded mode: {mode.stdout!r}")

        with step("Execute runtime process with streamed stdin"):
            process = sandbox.processes.start("cat")
            process.send_input("process-input\n")
            process.close_stdin()
            process_result = process.wait()
            assert_that(process_result.exit_code == 0, f"process failed: {process_result.stderr}")
            assert_that(
                process_result.stdout == "process-input\n",
                f"unexpected process stdout: {process_result.stdout!r}",
            )

        with step("Execute runtime-owned terminal"):
            terminal = sandbox.processes.start(
                "read line; printf 'terminal:%s' \"$line\"",
                terminal=SandboxTerminal(cols=120, rows=40),
            )
            terminal.resize(cols=160, rows=50)
            terminal.send_input("terminal-input\n")
            terminal_result = terminal.wait()
            assert_that(
                "terminal:terminal-input" in terminal_result.stdout,
                f"unexpected terminal output: {terminal_result.stdout!r}",
            )

        with step("Disconnect and resume runtime process"):
            process = sandbox.processes.start("sleep 1; printf resumed")
            process_id = process.id
            cursor = process.cursor
            process.disconnect()
            resumed = sandbox.processes.connect(process_id, offset=cursor)
            resumed_result = resumed.wait()
            assert_that(
                resumed_result.stdout == "resumed",
                f"unexpected resumed stdout: {resumed_result.stdout!r}",
            )

        with step("Pause sandbox"):
            sandbox = sandbox.pause()
            assert_that(sandbox.status == "paused", f"unexpected paused status: {sandbox.status}")

        with step("Resume sandbox"):
            sandbox = sandbox.resume()
            assert_that(sandbox.status == "running", f"unexpected resumed status: {sandbox.status}")

        with step("Prepare sandbox state for fork"):
            result = sandbox.exec("printf fork-state > /tmp/sdk-fork-state")
            assert_that(result.exit_code == 0, f"failed to prepare fork state: {result.stderr}")

        with step("Stop and fork sandbox"):
            sandbox = sandbox.stop()
            fork = sandbox.fork(name=f"sdk-py-fork-{uuid.uuid4().hex[:12]}")
            sandbox_ids.append(fork.id)
            assert_that(fork.id != sandbox.id, "fork reused the source sandbox ID")
            assert_that(fork.status == "running", f"unexpected fork status: {fork.status}")

        with step("Verify forked sandbox state"):
            result = fork.exec("cat /tmp/sdk-fork-state")
            assert_that(result.exit_code == 0, f"fork exec failed: {result.stderr}")
            assert_that(result.stdout == "fork-state", f"unexpected fork stdout: {result.stdout!r}")

        with step("Stop and delete fork"):
            fork.stop()
            delete_sandbox(fork)
            sandbox_ids.remove(fork.id)

        with step("Delete source sandbox"):
            delete_sandbox(sandbox)
            sandbox_ids.remove(sandbox.id)
    finally:
        for sandbox_id in reversed(sandbox_ids):
            try:
                sandbox = archil.sandboxes.get(sandbox_id)
                if sandbox.status not in {"stopped", "exited", "failed"}:
                    sandbox = sandbox.stop()
                delete_sandbox(sandbox)
            except ArchilError:
                pass


def run_s3_object_suite(disk) -> None:
    print("\n--- S3-compatible object API (put/get/head/list/delete) ---")
    prefix = f"sdk-s3-test-{uuid.uuid4()}/"
    key = f"{prefix}object.txt"
    body = f"s3 object test {uuid.uuid4()}".encode()

    with step("put_object returns an etag"):
        result = disk.put_object(key, body, "text/plain")
        assert_that(bool(result.etag), f"put_object returned no etag: {result.etag}")

    with step("get_object round-trips the bytes"):
        got = disk.get_object(key)
        assert_that(got == body, f"get_object mismatch: expected {body!r}, got {got!r}")

    with step("head_object reports size/etag; object_exists is true"):
        meta = disk.head_object(key)
        assert_that(meta is not None, "head_object returned None for an existing key")
        assert_that(meta.size == len(body), f"head_object size mismatch: {meta.size} != {len(body)}")
        assert_that(bool(meta.etag), f"head_object etag missing: {meta.etag}")
        assert_that(disk.object_exists(key) is True, "object_exists should be True")

    with step("list_objects includes the put key with correct size"):
        listing = disk.list_objects(prefix)
        found = next((o for o in listing.objects if o.key == key), None)
        assert_that(found is not None, f"list_objects missing {key}: {[o.key for o in listing.objects]}")
        assert_that(found.size == len(body), f"list_objects size mismatch: {found.size} != {len(body)}")

    with step("delete_object"):
        disk.delete_object(key)

    with step("list_objects no longer includes the deleted key; object_exists is false"):
        listing = disk.list_objects(prefix)
        assert_that(not any(o.key == key for o in listing.objects), f"list still returned deleted {key}")
        assert_that(disk.object_exists(key) is False, "object_exists should be False after delete")

    with step("get_object after delete raises a structured 404"):
        try:
            disk.get_object(key)
            raise AssertionError("expected get_object to fail after delete")
        except ArchilS3Error as err:
            assert_that(err.status == 404, f"expected status 404, got {err.status}")
            assert_that(err.code == "NoSuchKey", f"expected code NoSuchKey, got {err.code}")

    with step("delete_object is idempotent for a missing key"):
        disk.delete_object(key)

    # Keys with URL-reserved characters must round-trip — the SDK percent-encodes
    # each path segment, so '%', ' ', '+', '?', etc. reach the gateway intact.
    tricky_key = f"{prefix}100% (done) +final?.txt"
    tricky_body = b"reserved-char key body"
    with step("put/get/delete a key with reserved characters"):
        disk.put_object(tricky_key, tricky_body)
        assert_that(disk.get_object(tricky_key) == tricky_body, "reserved-char round-trip mismatch")
        disk.delete_object(tricky_key)

    # Multiple keys: listing, the limit cap, and the page iterator.
    page_keys = [f"{prefix}p/1.txt", f"{prefix}p/2.txt", f"{prefix}p/3.txt"]
    for k in page_keys:
        disk.put_object(k, k.encode())
    with step("list_objects returns all keys under a prefix (recursive)"):
        listing = disk.list_objects(f"{prefix}p/", recursive=True)
        for k in page_keys:
            assert_that(any(o.key == k for o in listing.objects), f"list missing {k}")
        assert_that(not listing.is_truncated, "unlimited result must not be truncated")
    with step("list_objects limit caps the total and reports truncation"):
        listing = disk.list_objects(f"{prefix}p/", recursive=True, limit=2)
        assert_that(len(listing.objects) == 2, f"limit=2 should return 2, got {len(listing.objects)}")
        assert_that(listing.is_truncated, "limited result should report is_truncated")
    with step("list_objects_pages yields the objects"):
        seen = []
        for page in disk.list_objects_pages(f"{prefix}p/", recursive=True):
            seen.extend(o.key for o in page.objects)
        for k in page_keys:
            assert_that(k in seen, f"list_objects_pages missing {k}: {seen}")
    for k in page_keys:
        disk.delete_object(k)


def run_agent_tools_suite(disk) -> None:
    """The agent filesystem tools over a real disk, driven through the actual
    BoundTool.invoke entry point (the path an agent framework hits). Covers the
    S3-backed tools — read/write/list/delete — plus error handling; grep and
    run_bash need the fleet exec stack, which this environment doesn't run."""
    print("\n--- Agent tools (single-disk filesystem tools) ---")
    tools = {t.name: t for t in disk.agent_tools().tools}

    def call(name: str, **args) -> str:
        return asyncio.run(tools[name].invoke(args))

    base = f"agent-tools-{uuid.uuid4()}"
    path = f"/{base}/notes.txt"

    with step("write_file stores bytes at the routed key"):
        out = call("write_file", path=path, content="hello from agent tools")
        assert_that("Wrote" in out, f"unexpected write_file result: {out!r}")
        stored = disk.get_object(f"{base}/notes.txt")
        assert_that(stored == b"hello from agent tools", f"bytes not stored at routed key: {stored!r}")

    with step("read_file returns the contents"):
        assert_that(call("read_file", path=path) == "hello from agent tools", "read_file mismatch")
        # A bare relative path resolves the same against the single disk.
        assert_that(call("read_file", path=f"{base}/notes.txt") == "hello from agent tools", "relative read mismatch")

    with step("list_files shows the file under its directory"):
        out = call("list_files", path=f"/{base}")
        assert_that("notes.txt" in out, f"list_files missing file: {out!r}")

    with step("read_file on a missing path returns a readable error, not a raise"):
        out = call("read_file", path=f"/{base}/missing.txt")
        assert_that("not found" in out.lower(), f"expected not-found error: {out!r}")

    with step("delete_file removes the object"):
        call("delete_file", path=path)
        assert_that(disk.object_exists(f"{base}/notes.txt") is False, "object not deleted")


def run_workspace_agent_tools_suite(archil, disk_a, disk_b) -> None:
    """Multi-disk workspace routing over two real disks: file operations must
    route to the disk named by the path, and list_files at the workspace root
    must fan out across both."""
    print("\n--- Agent tools workspace routing (multi-disk) ---")
    workspace = archil.workspace({"alpha": disk_a, "beta": disk_b})
    tools = {t.name: t for t in workspace.agent_tools().tools}

    def call(name: str, **args) -> str:
        return asyncio.run(tools[name].invoke(args))

    tag = uuid.uuid4().hex[:8]
    a_key, b_key = f"ws-{tag}-a.txt", f"ws-{tag}-b.txt"

    with step("writes route to the disk named by the path's first segment"):
        call("write_file", path=f"/alpha/{a_key}", content="A")
        call("write_file", path=f"/beta/{b_key}", content="B")
        assert_that(disk_a.get_object(a_key) == b"A", "alpha path did not route to disk_a")
        assert_that(disk_b.get_object(b_key) == b"B", "beta path did not route to disk_b")

    with step("list_files at the root names the disks; recursive fans out across both"):
        roots = call("list_files", path="/")
        assert_that("/alpha/" in roots, f"root listing missing alpha disk: {roots!r}")
        assert_that("/beta/" in roots, f"root listing missing beta disk: {roots!r}")

        out = call("list_files", path="/", recursive=True)
        assert_that(f"/alpha/{a_key}" in out, f"fan-out missing alpha entry: {out!r}")
        assert_that(f"/beta/{b_key}" in out, f"fan-out missing beta entry: {out!r}")

    with step("delete_file routes by path too"):
        call("delete_file", path=f"/alpha/{a_key}")
        call("delete_file", path=f"/beta/{b_key}")
        assert_that(disk_a.object_exists(a_key) is False, "alpha object not deleted")
        assert_that(disk_b.object_exists(b_key) is False, "beta object not deleted")


def run_s3_advanced_suite(disk) -> None:
    print("\n--- S3 large uploads, multipart, bulk delete, append ---")
    prefix = f"sdk-s3-adv-{uuid.uuid4()}/"

    # Two distinguishable parts (5 MiB 'A' + 1 MiB 'B'): a mis-ordered stitch
    # would corrupt the bytes, so the round-trip check verifies ordering too. The
    # last part may be < 5 MiB; only non-final parts must clear the 5 MiB floor.
    part_a = b"A" * (5 * 1024 * 1024)
    part_b = b"B" * (1 * 1024 * 1024)
    big_body = part_a + part_b

    small_key = f"{prefix}small.txt"
    with step("put_object keeps a small body as a single PUT (plain etag)"):
        res = disk.put_object(small_key, b"small body", "text/plain")
        assert_that(bool(res.etag), "put_object returned no etag")
        assert_that("-" not in (res.etag or ""), f"small put should not be multipart: {res.etag}")
    disk.delete_object(small_key)

    big_key = f"{prefix}big.bin"
    with step("put_object auto-switches a large body to multipart and round-trips"):
        res = disk.put_object(
            big_key, big_body, part_size=5 * 1024 * 1024, multipart_threshold=5 * 1024 * 1024
        )
        assert_that("-" in (res.etag or ""), f"large put should have a multipart etag: {res.etag}")
        got = disk.get_object(big_key)
        assert_that(got == big_body, f"multipart round-trip mismatch: {len(got)} != {len(big_body)}")
    disk.delete_object(big_key)

    # Manual lifecycle through the opt-in disk.multipart namespace.
    mp_key = f"{prefix}manual.bin"
    with step("disk.multipart create/upload_part/list_parts/list_uploads/complete"):
        upload = disk.multipart.create(mp_key)
        p1 = disk.multipart.upload_part(mp_key, upload.upload_id, 1, part_a)
        p2 = disk.multipart.upload_part(mp_key, upload.upload_id, 2, part_b)
        parts = disk.multipart.list_parts(mp_key, upload.upload_id)
        assert_that(len(parts.parts) == 2, f"expected 2 parts, got {len(parts.parts)}")
        uploads = disk.multipart.list_uploads(prefix=prefix)
        assert_that(
            any(u.upload_id == upload.upload_id for u in uploads.uploads),
            "list_uploads did not include the in-progress upload",
        )
        disk.multipart.complete(mp_key, upload.upload_id, [p1, p2])
        assert_that(disk.get_object(mp_key) == big_body, "manual multipart round-trip mismatch")
    disk.delete_object(mp_key)

    aborted_key = f"{prefix}aborted.bin"
    with step("disk.multipart.abort discards an in-progress upload"):
        upload = disk.multipart.create(aborted_key)
        disk.multipart.abort(aborted_key, upload.upload_id)
        uploads = disk.multipart.list_uploads(prefix=prefix)
        assert_that(
            not any(u.upload_id == upload.upload_id for u in uploads.uploads),
            "aborted upload is still listed",
        )

    # Bulk delete: present keys + an absent key (absent counts as deleted, per S3).
    bulk_keys = [f"{prefix}bulk/1.txt", f"{prefix}bulk/2.txt"]
    for k in bulk_keys:
        disk.put_object(k, b"x")
    with step("delete_objects removes many keys (missing key is idempotent)"):
        result = disk.delete_objects(bulk_keys + [f"{prefix}bulk/missing.txt"])
        assert_that(not result.errors, f"delete_objects reported errors: {result.errors}")
        for k in bulk_keys:
            assert_that(not disk.object_exists(k), f"{k} should be deleted")

    log_key = f"{prefix}app.log"
    with step("append_object creates then appends"):
        disk.append_object(log_key, b"line1\n")
        disk.append_object(log_key, b"line2\n")
        assert_that(disk.get_object(log_key) == b"line1\nline2\n", "append round-trip mismatch")
    disk.delete_object(log_key)


def main() -> None:
    api_key = require_env("ARCHIL_API_KEY")
    region = require_env("ARCHIL_REGION")
    base_url = os.environ.get("ARCHIL_BASE_URL")
    s3_base_url = os.environ.get("ARCHIL_S3_BASE_URL")

    disk_name = f"sdk-py-test-{uuid.uuid4().hex[:12]}"
    disk_id = None
    disk_b_id = None
    archil = Archil(api_key=api_key, region=region, base_url=base_url, s3_base_url=s3_base_url)

    try:
        run_sandbox_suite(archil)

        with step("Create disk"):
            result = archil.disks.create(name=disk_name)
            disk = result.disk
            disk_id = disk.id

        with step("Wait for disk available"):
            disk = disk.wait_until_ready(timeout=60.0)

        with step("Verify disk in list"):
            disks = archil.disks.list()
            assert_that(any(d.id == disk_id for d in disks), f"disk {disk_id} not found in list")

        with step("Get disk by ID"):
            d = archil.disks.get(disk_id)
            assert_that(d.name == disk_name, f'expected name "{disk_name}", got "{d.name}"')

        with step("Add token user"):
            user = disk.add_user(TokenUser(nickname="integration-test"))
            assert_that(bool(user.identifier), "add_user did not return an identifier")

        run_s3_object_suite(disk)
        run_s3_advanced_suite(disk)

        run_agent_tools_suite(disk)

        with step("Create second disk for workspace routing"):
            result_b = archil.disks.create(name=f"{disk_name}-b")
            disk_b = result_b.disk
            disk_b_id = disk_b.id

        with step("Wait for second disk available"):
            disk_b = disk_b.wait_until_ready(timeout=60.0)

        run_workspace_agent_tools_suite(archil, disk, disk_b)

        with step("Delete second disk"):
            disk_b.delete()
            disk_b_id = None

        with step("Delete disk"):
            disk.delete()
            disk_id = None

        with step("Verify disk deleted"):
            try:
                archil.disks.get(disk.id)
                raise AssertionError("expected get to fail after delete")
            except ArchilError as err:
                assert_that(
                    err.status == 404 or "not found" in str(err).lower(),
                    f"unexpected error after delete: {err}",
                )

        print("\nAll Python SDK integration tests passed!")
    except Exception as err:  # noqa: BLE001 — top-level test harness
        print(f"\nTest failed: {err}", file=sys.stderr)
        for cleanup_id in (disk_id, disk_b_id):
            if cleanup_id:
                print(f"Cleaning up disk {cleanup_id}...", file=sys.stderr)
                try:
                    archil.disks.get(cleanup_id).delete()
                    print("Cleaned up.", file=sys.stderr)
                except Exception:
                    print("Cleanup failed — disk may need manual deletion.", file=sys.stderr)
        sys.exit(1)
    finally:
        archil.close()


if __name__ == "__main__":
    main()
