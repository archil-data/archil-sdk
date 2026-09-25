---
"disk": minor
"archil": minor
---

Add `images.create()` / `images.get()` (`create_image` / `get_image` in Python) to build sandbox images, including from private registries with `registryAuth` / `registry_auth`, and accept a ready image or its digest as `image` when creating a sandbox. Requires a control plane with the sandbox images API.
