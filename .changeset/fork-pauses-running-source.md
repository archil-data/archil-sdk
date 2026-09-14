---
"disk": patch
---

Pause a running sandbox before forking it and resume it once the fork is accepted, so the fork no longer depends on the server finishing the pause within one request. Forks name the checkpoint the pause returned, so concurrent forks of one source share a single snapshot even when another client resumes the source first; `sandbox.checkpoint` exposes it.
