---
"disk": minor
---

Add opt-in sandbox egress `drain_on_pause` host/path wildcard selectors. Pausing waits for selected HTTP responses, including streams, and raises `SandboxPauseError` if the sandbox does not reach paused.
