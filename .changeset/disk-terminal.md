---
"disk": minor
---

Add `disk.connect()` to create a fresh sandbox with the disk mounted at `/mnt/archil`. It returns a `Sandbox` with an owned keepalive connection, so callers can use `sandbox.exec()`, `sandbox.run()`, and `sandbox.files` between commands. `sandbox.connected` tracks the connection and `sandbox.disconnect()` releases it. Sessions expire after 10 seconds without connections by default; files on the disk persist.
