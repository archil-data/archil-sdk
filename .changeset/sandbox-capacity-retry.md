---
"archil": minor
---

Sandbox create, start, resume, and fork now wait out a region with no capacity: on a 503 `no_capacity` or `runtime_retryable` (or a 429), they back off and retry, honoring `Retry-After`, and log a warning. Bound the wait with `Archil(max_throttle_wait=seconds)` or `ARCHIL_MAX_THROTTLE_WAIT`; unset waits indefinitely and `0` keeps the old fail-fast behavior. Forking a running sandbox does not wait, so its source is resumed promptly.
