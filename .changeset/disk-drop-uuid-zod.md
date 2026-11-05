---
"disk": minor
"@archildata/eve": patch
---

`disk` no longer depends on `uuid`, and `zod` is now an optional peer dependency used only by `disk/internal/tools`, so installing `disk` no longer pulls in `zod`. `@archildata/eve` now depends on `zod` directly.
