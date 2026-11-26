# archil

## 0.1.1

### Patch Changes

- ef0aa63: `archil login` fixes and polish:
  
  - Accept `Origin: null` on the sign-in callback. Some browsers send it when the HTTPS console posts to the CLI's `http://127.0.0.1` listener. The callback is still authenticated by its single-use state, and sites that send their own origin are still turned away.
  - Exit right after signing in. Previously the browser's idle keep-alive connection could hold the command open for a minute or two.
  - Warn after signing in when `ARCHIL_API_KEY`, `ARCHIL_REGION`, `ARCHIL_BASE_URL`, or `ARCHIL_PROFILE` is set, since those take precedence over the new profile. A 401 or 403 now says when the rejected key came from `ARCHIL_API_KEY`.
  - `archil sandbox` (or `archil disk`) without a subcommand prints its help without an error marker.
- 6321093: `archil sandbox ssh` now turns off mouse reporting, focus events, and bracketed paste, and shows the cursor, after ssh exits on a terminal. A remote program such as tmux or vim could leave these on when the connection dropped (for example when the sandbox paused at its timeout), so moving the mouse at the local prompt typed text like `35;26;11M`. The command also passes Ctrl-C, SIGTERM, and SIGHUP to ssh instead of exiting before it, so the shell never gets the terminal back while ssh still holds it. Plain `ssh <sandbox>.archil` sessions don't go through the CLI after ssh exits, so this doesn't cover them.
- Updated dependencies [ef0aa63]
- Updated dependencies [6321093]
  - disk@1.15.1

## 0.1.0

### Minor Changes

- 5ff2d85: Add the `archil` command, installed by the `archil` package. It covers disks and sandboxes (`archil disk ...`, `archil sandbox ...`) and passes commands it doesn't own, such as `mount`, through to the native Archil client.
  
  - `archil login`, `logout`, and `whoami`: sign in through the console in your browser; the API key is saved as a profile.
  - `archil sandbox ssh`, `ssh-proxy`, and `ssh-config --install`: real OpenSSH over the Archil API with no open port. scp, rsync, `-L`, and editor remotes work against `<sandbox>.archil` hosts.
  - `archil sandbox forward <id|name> <port>`: a private localhost tunnel for HTTP and WebSocket services.
  - `archil sandbox create --desktop` and `archil sandbox desktop`: VNC desktops opened privately through a tunnel; `--share` and `--unshare` manage a public link.
  - `archil completion bash|zsh|fish`, which completes sandbox names.
  - Progress spinners, live status lines, colored output, and errors with hints. Under `archil`, data commands print JSON when stdout is piped.
  
  Library: `client.sandboxes.create({ desktop: true })` and `sandbox.desktop`, with `start`, `share`, `unshare`, `token`, and computer-use helpers (`screenshot`, `size`, `click`, `moveMouse`, `scroll`, `type`, `key`, `launch`). A new Node-only entry point, `disk/tunnel`, provides `forwardPort` and `openDesktopTunnel` for private localhost access. These keep the sandbox awake and renew their access token.
  
  The existing `disk` and `sandbox` executables keep their output, error format, and exit codes. They gain the new sandbox subcommands and `create --desktop`, and show spinners only in an interactive terminal.

### Patch Changes

- Updated dependencies [5ff2d85]
  - disk@1.15.0

## 0.0.6

### Patch Changes

- Updated dependencies [3c02ca5]
- Updated dependencies [e7e73bf]
  - disk@1.14.0

## 0.0.5

### Patch Changes

- Updated dependencies [e8dc843]
- Updated dependencies [af464f1]
- Updated dependencies [3dd5c8f]
  - disk@1.13.0

## 0.0.4

### Patch Changes

- Updated dependencies [20dc96c]
  - disk@1.12.1

## 0.0.3

### Patch Changes

- Updated dependencies [340d4bb]
- Updated dependencies [036417b]
- Updated dependencies [e282728]
- Updated dependencies [4516a02]
- Updated dependencies [e491563]
  - disk@1.12.0

## 0.0.2

### Patch Changes

- Updated dependencies [2135fc1]
  - disk@1.11.0

## 0.0.1

### Patch Changes

- da3c538: Publish `archil` on npm as an alias for `disk`, so `npm install archil` installs the Archil TypeScript SDK. It re-exports everything from `disk`.
- Updated dependencies [d44913a]
  - disk@1.10.0
