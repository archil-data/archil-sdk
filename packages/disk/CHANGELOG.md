# disk

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
