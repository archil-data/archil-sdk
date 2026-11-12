---
"disk": minor
"@archildata/python": minor
---

Sandbox creation takes `onTimeout` (`on_timeout` in Python): `"pause"`, the default, or `"delete"`, which deletes the sandbox and its disk instead of pausing it when its hard or idle TTL runs out. Forks inherit it, and `sandbox.onTimeout` (`sandbox.on_timeout`) reads it back, as `"pause"` from control planes that predate it. `sandbox create` takes `--on-timeout pause|delete`.
