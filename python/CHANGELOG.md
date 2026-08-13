# Changelog

## 0.9.0

- Support `root_attrs` (uid/gid/mode) at disk creation: pass `RootAttrs` to `disks.create` / `create_disk` to set the POSIX owner and permission bits of the disk's root directory up front, and read the recorded attributes back via `Disk.root_attrs`.

## 0.8.27

- Move the SDK to `archil-data/archil-sdk`.
