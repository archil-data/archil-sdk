---
"disk": minor
"@archildata/python": minor
---

`images.build` builds from a Dockerfile: pass `dockerfile` (its text) instead of `source`, and optionally `context`, a local directory that `COPY` and `ADD` read from. The context is packed without the paths its `.dockerignore` excludes and uploaded only when the same files weren't uploaded before. A failed build's `ImageBuildError` ends with the build's output, which `Image.buildLog` (`build_log`) holds.
