---
"disk": minor
---

Add `sandbox.setTimeout()` for editing hard and idle TTLs independently or together. Expose `idleTtlSeconds` on sandbox creation and responses; zero disables idle expiry. Hard TTL defaults to 24 hours.
