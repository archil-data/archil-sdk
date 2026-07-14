---
"disk": minor
---

Add the sandbox API: `archil.sandbox.create/get/list/start` plus `Sandbox.run/stop/start/refresh`, wrapping the control plane's long-lived `/api/sandboxes` microVMs (async exec with polling, stop-and-resume lifecycle).
