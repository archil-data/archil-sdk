---
"disk": minor
---

Add `Disk.listDelegations()` and `Disk.revokeDelegation(delegation)` for inspecting and forcibly releasing the delegations held on a disk, plus the exported `Delegation` type. `revokeDelegation` takes the `{ clientId, inodeId }` pair identifying a delegation, so entries from `listDelegations()` can be passed directly.
