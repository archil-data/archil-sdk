---
"disk": minor
---

`disks.list()` now fetches in cursor-driven pages and follows the control plane's `nextCursor` until the listing is exhausted, so large accounts no longer force the server to enrich every disk under one request deadline. `limit` caps the total across pages. New `disks.listPage()` (and module-level `listDiskPage()`) returns a single `DiskListPage` with `nextCursor` for manual pagination. Servers without pagination support are handled transparently.
