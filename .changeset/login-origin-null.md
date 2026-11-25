---
"disk": patch
"archil": patch
---

Fix `archil login` with the production console: browsers send `Origin: null` when the HTTPS console posts the sign-in to the CLI's `http://127.0.0.1` listener, which the CLI rejected as "Not allowed". The callback is still authenticated by its single-use state, and other sites that send their own origin are still turned away.
