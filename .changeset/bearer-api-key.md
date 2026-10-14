---
"disk": patch
"archil": patch
---

Send the API key as a standard bearer token (`Authorization: Bearer key-…`) on control-plane and S3 requests, so credential-injecting proxies that only rewrite `Bearer` tokens work. The key is accepted with or without its `key-` prefix.
