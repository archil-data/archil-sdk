---
"disk": patch
"@archildata/python": patch
---

Document the API's new default: a sandbox created without an idle TTL pauses after 30 minutes without a direct process connection. Pass `idleTtlSeconds: 0` (`idle_ttl_seconds=0` in Python) to keep it running.
