---
"disk": minor
---

Add `disk.connect()` to open a Bash PTY on a warm VM with the disk mounted at `/mnt/archil`. The returned process supports input, resizing, disconnect, and reconnect within the idle timeout.
