---
"disk": minor
"archil": minor
---

Add `images.build()` to build a sandbox image from an OCI reference, including private registries, and wait until it is ready, plus `images.get()`. Create sandboxes from a built image with `imageId` (`image_id` in Python); sandboxes expose `imageDigest` (`image_digest`). A failed build raises `ImageBuildError` with the server's failure reason. TypeScript `ArchilApiError.code` now carries the control plane's error code, such as `image_not_ready`, as Python already does.
