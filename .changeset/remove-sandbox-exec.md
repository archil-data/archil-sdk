---
"disk": major
---

Remove the deprecated control-plane sandbox exec resources and raw connection API. `sandbox.exec()` now starts and waits for a runtime-owned process; use `sandbox.processes` to detach, reconnect, stream input, resize, or kill.
