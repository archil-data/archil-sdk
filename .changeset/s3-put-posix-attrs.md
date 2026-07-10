---
"disk": patch
---

Add optional `mode` / `uid` / `gid` on `putObject`, `appendObject`, and `multipart.create`, sent as `x-archil-mode` / `x-archil-uid` / `x-archil-gid` so published files match non-root sandbox users (e.g. Daytona uid 1000).
