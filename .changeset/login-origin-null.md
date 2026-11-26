---
"disk": patch
"archil": patch
---

`archil login` fixes and polish:

- Accept `Origin: null` on the sign-in callback. Some browsers send it when the HTTPS console posts to the CLI's `http://127.0.0.1` listener. The callback is still authenticated by its single-use state, and sites that send their own origin are still turned away.
- Exit right after signing in. Previously the browser's idle keep-alive connection could hold the command open for a minute or two.
- Warn after signing in when `ARCHIL_API_KEY`, `ARCHIL_REGION`, `ARCHIL_BASE_URL`, or `ARCHIL_PROFILE` is set, since those take precedence over the new profile. A 401 or 403 now says when the rejected key came from `ARCHIL_API_KEY`.
- `archil sandbox` (or `archil disk`) without a subcommand prints its help without an error marker.
