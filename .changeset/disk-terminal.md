---
"disk": minor
---

Add `disk.connect()` to open a fresh ephemeral Bash PTY with the disk mounted at `/mnt/archil`. The returned process supports input, resizing, and disconnect. Sessions expire after 10 seconds disconnected by default; files on the disk persist.
