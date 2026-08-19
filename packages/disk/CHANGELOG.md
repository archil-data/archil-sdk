# disk

## 0.11.0

### Minor Changes

- ae19201: Add runtime-owned sandbox processes with optional terminal I/O, disconnect, and reconnect support.
- 36be5e2: Add streaming file transfers between local clients and running sandboxes.

## 0.10.0

### Minor Changes

- 1548884: Support `rootAttrs` (uid/gid/mode) at disk creation: pass `rootAttrs` in `disks.create` to set the POSIX owner and permission bits of the disk's root directory up front, and read the recorded attributes back via `Disk.rootAttrs`. Requires `@archildata/api-types` 0.0.18, which types the field on `CreateDiskRequest` and `DiskResponse`.

## 0.9.0

### Minor Changes

- 9aa3141: Allow sandbox creation requests to specify vCPU count and memory size.
- bb2e683: Default `wait` to true, delegate the initial wait to the server, and poll only if the server's wait budget expires.
- b9610a3: Add interactive PTY support to `sandbox.exec()`.
- b9610a3: Add sandbox names, image metadata, forks, interactive connection URLs, and deletion.

## 0.8.23

### Patch Changes

- 45df6fe: Add sandbox creation, listing, lifecycle (including pause and resume), and command execution APIs.

## 0.8.22

### Patch Changes

- 6250abe: Add `Disk.listDelegations()` and `Disk.revokeDelegation(delegation)` for inspecting and forcibly releasing the delegations held on a disk, plus the exported `Delegation` type. `revokeDelegation` takes the `{ clientId, inodeId }` pair identifying a delegation, so entries from `listDelegations()` can be passed directly.

## 0.8.21

### Patch Changes

- 7d1d144: expose POSIX mode/uid/gid on putObject, appendObject, and multipart.create

## 0.8.20

### Patch Changes

- a60afde: update dependencies and add pagination for disks.list()

## 0.8.19

### Patch Changes

- da5ab50: added support for agent tools
