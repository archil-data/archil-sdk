---
"disk": minor
---

Reuse a binary connection for concurrent sandbox processes, with fallback for older runtimes. Idle connections close after five seconds; `sandbox.processes.disconnect()` closes them explicitly without terminating guest processes.
