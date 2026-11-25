---
"disk": minor
"archil": minor
---

Add the `archil` command, installed by the `archil` package. It covers disks and sandboxes (`archil disk ...`, `archil sandbox ...`) and passes commands it doesn't own, such as `mount`, through to the native Archil client.

- `archil login`, `logout`, and `whoami`: sign in through the console in your browser; the API key is saved as a profile.
- `archil sandbox ssh`, `ssh-proxy`, and `ssh-config --install`: real OpenSSH over the Archil API with no open port. scp, rsync, `-L`, and editor remotes work against `<sandbox>.archil` hosts.
- `archil sandbox forward <id|name> <port>`: a private localhost tunnel for HTTP and WebSocket services.
- `archil sandbox create --desktop` and `archil sandbox desktop`: VNC desktops opened privately through a tunnel; `--share` and `--unshare` manage a public link.
- `archil completion bash|zsh|fish`, which completes sandbox names.
- Progress spinners, live status lines, colored output, and errors with hints. Under `archil`, data commands print JSON when stdout is piped.

Library: `client.sandboxes.create({ desktop: true })` and `sandbox.desktop`, with `start`, `share`, `unshare`, `token`, and computer-use helpers (`screenshot`, `size`, `click`, `moveMouse`, `scroll`, `type`, `key`, `launch`). A new Node-only entry point, `disk/tunnel`, provides `forwardPort` and `openDesktopTunnel` for private localhost access. These keep the sandbox awake and renew their access token.

The existing `disk` and `sandbox` executables keep their output, error format, and exit codes. They gain the new sandbox subcommands and `create --desktop`, and show spinners only in an interactive terminal.
