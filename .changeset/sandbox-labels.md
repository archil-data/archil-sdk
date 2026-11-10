---
"disk": minor
"archil": minor
---

Label sandboxes: `labels` on `sandboxes.create()` and `fork()`, and a `labels` field on every sandbox. A fork keeps its source's labels unless `labels` is given; `{}` clears them. `sandboxes.list()` filters by `labels`, `name`, and `namePrefix` (`name_prefix` in Python) and now follows the server's pages until none remain.
