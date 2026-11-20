---
"disk": patch
---

Serve Node a build that imports undici with literal specifiers (under the `node` export condition), so server bundlers and file tracers such as Vercel and Nitro include undici. Browser builds still never reference it.
