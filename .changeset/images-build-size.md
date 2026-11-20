---
"disk": minor
"@archildata/python": minor
---

`images.build` takes the size its build prepares sandboxes to start at from a snapshot (`vcpuCount` / `memSizeMiB`; Python `vcpu_count` / `mem_size_mib`, default 1 vCPU / 2048 MiB), and `Image` reports the size sandboxes created from it get.
