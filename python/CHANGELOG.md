# Changelog

## Unreleased

- Remove the deprecated sandbox exec and raw connection APIs. Use `sandbox.processes` instead.

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
