---
"disk": minor
"@archildata/eve": patch
---

`disk` now depends only on `@archildata/api-types` and `undici`. It no longer installs `uuid`, `openapi-fetch`, `fast-xml-parser`, `commander`, or `@clack/prompts`: the control-plane client, S3 XML parsing, and the `disk`/`sandbox` command-line parsing, spinner, and API-key prompt are built in. `zod` is now an optional peer dependency used only by `disk/internal/tools`, so installing `disk` no longer pulls it in; `@archildata/eve` now depends on `zod` directly. S3 listings now keep leading and trailing spaces in object keys (they were trimmed) and decode numeric character references such as `&#233;`.
