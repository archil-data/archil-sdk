---
"disk": minor
---

Survive load-balancer HTTP/2 connection retirement. Control-plane and S3 requests now run on Undici 8.10.2 through its own `fetch`: requests already accepted when a graceful `GOAWAY` arrives finish normally, and requests the server refused are replayed on a fresh session instead of failing with `HTTP/2: "GOAWAY" frame received with code 0`. Idle sessions close after 30 seconds, ahead of the load balancer's idle timeout. Control-plane reads (`disks.get`, `disks.list`, `tokens.list`, `disk.listDelegations`, `disk.getAllowedIPs`) retry transient failures the way sandbox calls already do. Requires Node.js 22.19 or newer.
