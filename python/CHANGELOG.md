# Changelog

## Unreleased

- Add `sandbox.run()` to start a process and return its handle immediately, including PTYs, and `sandbox.attach()` to reconnect by process ID and output cursor. `sandbox.exec()` still waits for the command result. Keep `sandbox.processes.start()`, `sandbox.processes.connect()`, and the `SandboxProcesses` export as deprecated compatibility APIs until the next version.

## 0.13.0

- Add sandbox port tokens for private HTTP access: create, get, list/paginate, and delete tokens with optional expiration, in both sync and async APIs.

- Add public sandbox ports: pass `ports` at creation, or use `expose_port()`, `list_ports()`, and `unexpose_port()` on an existing sandbox. Expose returns the public hostname; list returns entries containing the port number and hostname.
- Add `sandbox.set_timeout()` for editing hard and idle TTLs independently or together. Expose `idle_ttl_seconds` on sandbox creation and responses; zero disables idle expiry. Hard TTL defaults to 24 hours.
- Remove `Sandbox.expires_at`; the API no longer exposes the estimated sandbox deadline. Connection-token expiry is unchanged.
- `fork()` pauses a running sandbox before taking the snapshot and resumes it once the fork is accepted, so the fork no longer depends on the server finishing the pause within one request. Paused and stopped sandboxes are forked in place.
- Forks name the checkpoint returned by pause, so concurrent forks of one source share a single snapshot even when another client resumes the source first. `Sandbox.checkpoint` exposes it.

## 0.12.2

- Share HTTP/2 control-plane connections across clients with matching origins and credentials, with up to 100 connections per shared pool.

## 0.12.1

- Add typed outbound HTTPS header transformations for sandbox credential brokering.
- Retry transient sandbox control-plane and process WebSocket connection failures.

## 0.12.0

- Add typed sandbox egress network policies with IPv4, CIDR, exact-domain, and wildcard-domain targets, including live policy reads and replacement on running sandboxes.
- Remove the deprecated exec resources and raw connection API. `sandbox.exec()` now starts
  and waits for a runtime-owned process; use `sandbox.processes` for detachable and resumable processes.

## 0.11.0

- Add runtime-owned sandbox processes with terminal I/O, disconnect, and reconnect support.
- Add streaming file uploads and downloads for running sandboxes.

## 0.10.0

- Add persistent sandbox support, including lifecycle operations, forks,
  non-interactive command execution, interactive PTYs, and sync/async APIs.

## 0.9.0

- Support `root_attrs` (uid/gid/mode) at disk creation: pass `RootAttrs` to `disks.create` / `create_disk` to set the POSIX owner and permission bits of the disk's root directory up front, and read the recorded attributes back via `Disk.root_attrs`.

## 0.8.27

- Move the SDK to `archil-data/archil-sdk`.
