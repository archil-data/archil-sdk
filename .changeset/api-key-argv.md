---
"disk": patch
"archil": patch
---

Keep API keys passed with `--api-key` out of the process list:

- `--api-key -` (or `-k -`) now reads the key from stdin. Before, it sent `-` as the key.
- When a literal key is passed with `--api-key` / `-k`, the `disk`, `sandbox`, and `archil` CLIs overwrite it with `***` in the process's command line as soon as they start, and print a warning. On Linux, other users could read the key from `ps` or `/proc/<pid>/cmdline` for as long as the command ran. A short window at startup remains, so prefer `ARCHIL_API_KEY`, a saved profile, or `--api-key -`, and rotate keys you've passed on the command line on shared machines.
