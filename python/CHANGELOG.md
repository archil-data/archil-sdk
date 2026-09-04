# Changelog

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
