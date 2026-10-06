---
"disk": patch
"archil": patch
---

Disk listing now always sends a `limit` query parameter. Previously `list({ name })` / `list(name=...)` and TypeScript `listPage()` sent no limit when you didn't pass one, leaving the page size up to the server; they now default to 100, the server's maximum.
