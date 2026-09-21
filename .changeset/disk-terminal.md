---
"disk": minor
---

Add `disk.connect()` to open a fresh ephemeral Bash PTY with the disk mounted at `/mnt/archil`. The returned process supports input, resizing, and disconnect. Sessions expire after 10 seconds disconnected by default; files on the disk persist.

Add `sandbox.run()` to start a process and return its handle immediately, including PTYs, and `sandbox.attach()` to reconnect by process ID and output cursor. `sandbox.exec()` still waits for the command result. Keep `sandbox.processes.start()`, `sandbox.processes.connect()`, and the `SandboxProcesses` export as deprecated compatibility APIs until the next version.
