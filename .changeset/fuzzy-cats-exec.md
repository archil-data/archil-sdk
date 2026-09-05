---
"disk": patch
---

Add `client.disks.exec(diskId, command)` for callers that already know the disk exists and do not need to fetch its metadata before execution.
