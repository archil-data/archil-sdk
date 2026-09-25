---
"disk": minor
"archil": minor
---

Add `sandbox.run()` to start a process and return its handle immediately, including PTYs, and `sandbox.attach()` to reconnect by process ID and output cursor. `sandbox.exec()` still waits for the command result. Keep `sandbox.processes.start()`, `sandbox.processes.connect()`, and the `SandboxProcesses` export as deprecated compatibility APIs until the next version.
