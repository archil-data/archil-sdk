---
"disk": patch
"archil": patch
---

`archil sandbox ssh` now turns off mouse reporting, focus events, and bracketed paste, and shows the cursor, after ssh exits on a terminal. A remote program such as tmux or vim could leave these on when the connection dropped (for example when the sandbox paused at its timeout), so moving the mouse at the local prompt typed text like `35;26;11M`. The command also passes Ctrl-C, SIGTERM, and SIGHUP to ssh instead of exiting before it, so the shell never gets the terminal back while ssh still holds it. Plain `ssh <sandbox>.archil` sessions don't go through the CLI after ssh exits, so this doesn't cover them.
