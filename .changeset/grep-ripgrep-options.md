---
"disk": minor
"@archildata/python": minor
---

`grep` accepts `ignoreCase`, `multiline`, `globs`, `types`, `typesNot`, `contextBefore`, and `contextAfter` (snake_case in Python), and returns each multiline match's `endLine` and, with context, `groups` of matching and context lines. At a workspace's root, a glob with a `/` must start with a mount name, like `data/src/**`, or with `**/`. The `disk grep` CLI gains `-i`, `-U`, `-g`, `-t`, `-T`, `-A`, `-B`, and `-C`.
