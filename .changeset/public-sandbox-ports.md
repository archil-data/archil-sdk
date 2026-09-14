---
"disk": minor
---

Add public sandbox ports: pass `ports` at creation, or use `exposePort()`, `listPorts()`, and `unexposePort()` on an existing sandbox. Expose returns the public hostname; list returns entries containing the port number and hostname.
