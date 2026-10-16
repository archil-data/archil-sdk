---
"disk": patch
"@archildata/python": patch
---

Send the API key exactly as given as a standard bearer token (`Authorization: Bearer <key>`) on control-plane and S3 requests, so credential-injecting proxies that substitute a placeholder token work. Keys without their `key-` prefix need a control plane that accepts them after `Bearer`.
