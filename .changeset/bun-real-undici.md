---
"disk": patch
---

The SDK works under Bun. Bun replaces the `undici` package with a stub of its own HTTP/1.1 fetch, which made every client call fail with a `TypeError` while setting up the HTTP/2 transport; the SDK now loads the real `undici` there, so Bun gets the same pooled HTTP/2 transport, retries, and `tls.ca` support as Node.
