---
"disk": minor
---

Support `rootAttrs` (uid/gid/mode) at disk creation: pass `rootAttrs` in `disks.create` to set the POSIX owner and permission bits of the disk's root directory up front, and read the recorded attributes back via `Disk.rootAttrs`. Requires `@archildata/api-types` 0.0.18, which types the field on `CreateDiskRequest` and `DiskResponse`.
