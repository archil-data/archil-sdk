---
"disk": patch
---

Processes started after `start()`, `stop()`, `pause()`, `resume()` or `fork()` open a fresh process connection. The shared connection from 1.13.0 stayed bound to the host the sandbox ran on before, so after a pause and resume every command failed with `session_rejected: Container not found`. A process the runtime rejects that way, for example after another client paused and resumed the sandbox, is retried once on a fresh connection.
