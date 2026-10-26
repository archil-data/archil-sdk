---
"disk": minor
---

Reuse a binary connection for concurrent sandbox processes. Idle connections close after five seconds; `sandbox.processes.disconnect()` closes them explicitly without terminating guest processes. Unread output now pauses the process's output stream instead of disconnecting it, and `sendInput()` waits while a process is not reading its input. Processes expose output as an async iterator, `output`; `onOutput` still works and waits for a returned promise before delivering more.
