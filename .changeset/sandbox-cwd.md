---
"disk": minor
---

Add an optional absolute `cwd` to sandbox `run()`, `exec()`, and the legacy `processes.start()` API, including PTYs. Requires runtime support for the `cwd` connection field.
