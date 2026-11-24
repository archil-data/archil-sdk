---
"disk": minor
---

`archil.exec({ ..., stream: true })` runs a command in a fresh VM and streams its stdin, stdout and stderr while it runs, returning the same process handle as `sandbox.run()`. It takes the same options as a waiting exec, plus `cwd`, `env`, `terminal` and `timeoutSeconds`. Concurrent streamed execs share one connection, up to 32 at a time. Node.js and Bun only.
