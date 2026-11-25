---
"disk": minor
"archil": minor
---

Add the `archil` command (`npx archil disk ...`, `npx archil sandbox ...`), installed by the `archil` package. It passes commands it doesn't own, such as `mount`, through to the native Archil client. Add VNC desktops to the sandbox CLI: `sandbox create --desktop` starts one, and `sandbox desktop <id|name>` opens it privately through a localhost tunnel. `--share` prints a public link and `--unshare` revokes it. The `disk` and `sandbox` executables are unchanged.
