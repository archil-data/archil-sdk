---
"disk": minor
"archil": minor
---

Add a `checkpoint` option to sandbox `fork()` (and `--checkpoint` to `sandbox fork` in the CLI) to fork the state saved by any earlier pause or stop without pausing or resuming the source. Forking checkpoints older than the previous session requires control-plane support.
