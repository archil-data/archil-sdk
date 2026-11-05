---
"disk": minor
"@archildata/python": minor
---

Attaching to a sandbox process now takes it over: the runtime closes the connection that held it, and that connection's `wait()` fails with "Process was taken over by another connection". Pass `shared: true` (`shared=True` in Python) to watch alongside the owner instead; a shared connection's `wait()` fails with "Process owner disconnected" when the owner's connection closes.
