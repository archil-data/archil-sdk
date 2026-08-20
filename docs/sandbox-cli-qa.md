# Sandbox CLI QA report

**Date:** 2026-08-20
**Stack:** [PR #49 — named profiles](https://github.com/archil-data/archil-sdk/pull/49) → [PR #56 — sandbox CLI](https://github.com/archil-data/archil-sdk/pull/56)
**Tested commit:** `0a0d2a121b3952105f244f34212c654cd81ef335`
**Live environment:** test yellow (`aws-us-east-1`) using the existing saved API key and the test-yellow control-plane URL

## Verdict

**Do not release the CLI yet.** The basic lifecycle is usable, but there are four release-blocking failures:

1. `--mem-size-mib` is silently ignored.
2. `sandbox run` corrupts normal multi-argument command lines.
3. `sandbox shell` does not return after `exit`, and its documented `Ctrl+]` emergency escape also fails to return.
4. The advertised `--port` functionality is rejected by test yellow's control plane.

There are also two profile bugs that can break authentication or silently redirect a custom/test profile to the default control plane.

## Release blockers

### 1. `--mem-size-mib` is silently ignored

**Severity:** blocker
**Area:** `packages/disk/src/cli/sandbox-command.ts`, `packages/disk/src/cli/sandbox-options.ts`

Commander converts `--mem-size-mib` to `options.memSizeMib`, but `CreateSandboxCliOptions` and `parseCreateSandboxOptions()` read `options.memSizeMiB`. The value is therefore always `undefined`.

Live evidence:

```console
$ sandbox create good --mem-size-mib 255
# Exit 0; sandbox created with 2048 MiB instead of rejecting the documented minimum.

$ sandbox create qa-retest --mem-size-mib 512 -o json
{
  "memSizeMiB": 2048
}
```

The unit test calls `parseCreateSandboxOptions()` directly with a hand-written `memSizeMiB` property, so it bypasses Commander's actual option-name conversion and does not detect this.

**Recommended fix:** align the Commander attribute name and TypeScript property, then add an end-to-end parser test that invokes `createSandboxProgram().parseAsync()` with `--mem-size-mib`. Assert both the outgoing request and invalid-value rejection.

### 2. `sandbox run` loses argument boundaries and shell quoting

**Severity:** blocker
**Area:** `packages/disk/src/cli/sandbox-command.ts:193`

The CLI receives `<command...>` as an argument array and reconstructs it with `command.join(" ")`. The user's shell has already removed quoting, so joining cannot recover argument boundaries. Spaces and shell metacharacters are reinterpreted by the remote shell.

Live repro:

```console
$ sandbox run "$ID" -- sh -c 'printf "arg:<%s>\n" "hello world"'
sh: usage: printf FORMAT [ARGUMENT...]
# Exit 2

$ sandbox run "$ID" -- printf '<%s>\n' 'a b' 'x;y'
/bin/sh: can't open %s: no such file
/bin/sh: y: not found
# Exit 127
```

A single, fully quoted command string works, but that is surprising given the `<command...>` help syntax and the common `-- sh -c '...'` convention.

**Recommended fix:** decide on one explicit contract:

- Preserve argv semantics by shell-escaping every collected argument before constructing the remote command; or
- Accept exactly one shell command string and document that the entire command must be quoted.

Add regressions for spaces, quotes, semicolons, `$`, empty arguments, and `sh -c`.

### 3. Interactive shell cannot exit cleanly

**Severity:** blocker
**Area:** `packages/disk/src/cli/sandbox-shell.ts` and/or process WebSocket exit handling

Tested through a real local PTY using `pexpect`, not redirected stdin:

1. Opened `sandbox shell <id>`.
2. Waited for `Archil shell process ...; Ctrl+] exits`.
3. Sent `echo shell-ok`; it executed successfully.
4. Sent `exit`; the remote prompt accepted it, but the CLI did not return within 10 seconds.
5. Sent byte `0x1d` (`Ctrl+]`); the CLI still did not return within another 10 seconds.

The same hang reproduced using `script(1)` with delayed input. The shell's command/input path works; completion does not.

The emergency path currently calls `remote.kill()` and then still waits on `remote.wait()`. Even if the control-plane exit event is delayed or missing, an emergency escape should restore the terminal and return after kill acknowledgement. Also investigate why normal process exit is not settling `remote.wait()` in test yellow.

There is a second static edge: stdin listeners are attached before `remote` is assigned. Input typed while the process connection is being established is silently dropped by `remote?.sendInput(...)`.

### 4. `--port` is incompatible with test yellow

**Severity:** blocker for the advertised port feature
**Area:** SDK/control-plane API contract

This was retested after the control-plane deployment was updated. It still fails before creating a sandbox:

```console
$ sandbox create qa-retest --port 8080/tcp
Error (400): port_mappings is not supported for sandboxes; create a sandbox service with tcp_port instead
```

The CLI, README, Node SDK, generated API types, and deployed control plane disagree about whether a sandbox accepts `port_mappings`. Reconcile the product model before release: either implement the deployed sandbox-service/`tcp_port` flow or remove `--port` and `CreateSandboxRequest.portMappings` until supported.

## High/medium-priority findings

### 5. Re-login silently clears a profile's saved base URL

**Severity:** high for custom/test control planes
**Area:** `packages/disk/src/cli/common.ts:44`

Repro with an isolated profile directory:

```console
$ sandbox auth login --profile relog --region aws-us-east-1 \
    --base-url https://control.yellow.us-east-1.aws.test.archil.com
$ sandbox auth login --profile relog
$ sandbox profile list
# The profile now shows "default" instead of the saved test-yellow URL.
```

The second login preserves the old region but writes `baseUrl: global.baseUrl`, which is `undefined`. A credential refresh can therefore redirect later commands away from the intended control plane.

**Recommended fix:** preserve `config.profiles[name]?.baseUrl` when no new base URL was supplied, just as region is preserved. Add a re-login regression test.

### 6. Logged-out selected profiles fail with raw `ENOENT`

**Severity:** medium
**Area:** `packages/disk/src/cli/credentials.ts`, auth/profile UX

```console
$ sandbox auth logout --profile test-yellow
Logged out profile 'test-yellow'
$ sandbox list --profile test-yellow
ENOENT: no such file or directory, stat '.../credentials/test-yellow.key'
```

Logout intentionally retains profile metadata, but `readProfileCredential()` assumes the credential file exists. Convert a missing credential file into the normal “Missing API key / run auth login” diagnostic. It would also help if `profile list` indicated whether each profile is logged in.

This issue is already reported in an unresolved review thread on PR #49.

### 7. Timed-out commands fail silently

**Severity:** medium
**Area:** `sandbox run` result reporting

```console
$ sandbox run "$ID" --timeout 1 -- 'sleep 5'
# Exit 1 after about 2 seconds; stdout and stderr are both empty.
```

The process result distinguishes `timed_out`, `failed`, and `cancelled`, but the CLI only maps a missing remote exit code to local exit 1. Print a concise diagnostic such as `Process timed out after 1 second` to local stderr when no remote diagnostic exists.

### 8. Fork deletion has a transient dependency race

**Severity:** low/medium operational edge

After successfully deleting a fork, the fork disappeared from `sandbox list`, but deleting its parent immediately returned:

```console
Error (409): sandbox has dependent forks: delete 1 child sandbox disk first: ...
```

The referenced child disk already returned 404 through the disk CLI. Retrying parent deletion after 10 seconds succeeded. The CLI could retry this specific eventual-consistency conflict for a short bounded period, or the control plane could make fork deletion synchronously clear the dependency.

### 9. `--no-wait` has no corresponding wait primitive

**Severity:** low UX improvement

Transient states are intentionally rejected by the local state matrix. For example, an immediate follow-up operation while a sandbox is `pausing` fails and the caller must poll `get -o json` manually. Consider `sandbox wait <id|name> [--status ...]` or a documented polling recipe so `--no-wait` is practical in scripts.

### 10. Every ID lookup lists all sandboxes first

**Severity:** low scalability/consistency improvement
**Area:** `resolveSandbox()`

Even an exact sandbox ID calls `service.list()` and scans every result. Exact IDs should use `sandboxes.get(id)` directly, falling back to a list only for name resolution. This reduces latency and avoids stale-list behavior as account sandbox counts grow.

## Stack/review sharp edge

PR #56 currently includes commit `1d9f0c8` for the breaking sandbox exec API replacement/removal while [PR #48](https://github.com/archil-data/archil-sdk/pull/48) remains open independently against `main`. PR #56's body acknowledges this temporary duplication. Rebase/update the stack once #48 lands so the CLI PR does not accidentally become the merge path for unrelated Node and Python breaking changes.

## Workflows that passed

The following worked against test yellow:

- Built CLI packaging includes executable `dist/sandbox-cli.mjs`; `pnpm --filter disk pack --dry-run` includes it.
- `--help` and subcommand help are complete and readable.
- Headless `auth login` from stdin works.
- Profile metadata and credential files are written with mode `0600`.
- Saved-profile authentication works without passing credentials on subsequent commands.
- `list` and `get` produce valid JSON; table output is readable.
- Name and numeric option validation generally produce concise errors (except the memory option bug).
- Sandbox create works with custom image, TTL, max process count, and environment variables.
- Create-time environment variables and per-run environment overrides work, including values containing spaces.
- Remote stdout/stderr are routed to the matching local streams.
- Remote nonzero exit code `7` is propagated as local exit code `7`.
- Fork succeeded after the control-plane update and preserved a seeded file.
- `pause`, `resume`, `stop`, and `start` completed with correct final states.
- A paused cold start correctly requires `--yes` in noninteractive use.
- Non-TTY `sandbox shell` fails clearly instead of corrupting the terminal.
- No QA-created sandboxes remained after cleanup.

## Automated verification

All final verification passed when run sequentially:

```text
pnpm run build                         PASS
pnpm run typecheck                     PASS
pnpm run test                          PASS
pnpm --filter disk build               PASS
pnpm --filter disk typecheck           PASS
pnpm --filter disk test                PASS (15 files, 108 tests)
pnpm --filter disk pack --dry-run      PASS

git diff main...HEAD --check           PASS
git diff c3f91b3...HEAD --check        PASS
```

## Test coverage improvements

Add live-shaped or parser-level regressions for the gaps found here:

1. Invoke Commander with `--mem-size-mib`; do not only unit-test the manually constructed options object.
2. Exercise `run` through the actual CLI parser with multi-argument commands and shell metacharacters.
3. Add a PTY integration test that requires both ordinary `exit` and `Ctrl+]` to return and restore raw mode.
4. Add a contract/integration test against the deployed control plane for every create field, especially port mappings.
5. Test re-login while preserving an existing base URL.
6. Test normal command execution after `auth logout` and assert a friendly missing-credential error.
7. Assert visible diagnostics for timeout/cancel/failure results that have no stderr.

## Remediation status and retest checklist

The findings above remain the original evidence from commit `0a0d2a1`. The remediation work is tracked here without rewriting that history.

| Finding | Remediation | Retest status |
| --- | --- | --- |
| 1. Memory option ignored | Align Commander's `memSizeMib` attribute and add parser-level coverage. | Automated PASS; live retest pending |
| 2. Run argument corruption | POSIX-quote each collected argv token; keep `sh -c` explicit. | Automated PASS; live retest pending |
| 3. Shell cannot exit | Return after acknowledged emergency kill, buffer startup input, and pause local stdin during cleanup so Node can exit. | Unit, real-PTY fixture, and deployed retest PASS |
| 4. Unsupported ports | Remove sandbox port mappings from this SDK/CLI; API-types contract update remains external. | SDK/CLI automated PASS; API-types release pending |
| 5. Re-login clears URL | Preserve omitted region/base URL values and test explicit replacement. | Automated PASS; live retest pending |
| 6. Logged-out profile ENOENT | Emit a profile-specific login diagnostic and show login state in `profile list`. | Automated PASS; live retest pending |
| 7. Silent timeout | Emit fallback diagnostics for timeout, failure, and cancellation without remote stderr. | Automated PASS; live retest pending |
| 8. Fork deletion race | Fix synchronously in the control plane; do not mask it with client retries. | Control-plane integration and live retest pending |
| 9. No wait primitive | Add `sandbox wait` with stable-state targeting and a bounded timeout. | Automated PASS; live retest pending |
| 10. ID lookup lists all | Use direct `get` for canonical UUID sandbox IDs and list only for names. | Automated PASS |

Repository verification after remediation:

```text
pnpm run build                         PASS
pnpm run typecheck                     PASS
pnpm run test                          PASS
pnpm --filter disk build               PASS
pnpm --filter disk typecheck           PASS
pnpm --filter disk test                PASS (16 files, 115 tests)
pnpm --filter disk pack --dry-run      PASS
git diff --check                       PASS
git diff main...HEAD --check           PASS
git diff c3f91b3...HEAD --check        PASS
```

### Live remediation retest against test yellow

The locally built remediation was exercised against test yellow after automated verification:

- **PASS:** `--mem-size-mib 255` was rejected locally; a 512 MiB sandbox was created with `memSizeMiB: 512`.
- **PASS:** argv preservation retained a spaced argument, `x;y`, and an empty argument through explicit `sh -c`.
- **PASS:** a one-second process timeout exited 1 and printed `Process timed out after 1 second` plus the remote reason.
- **PASS:** `pause --no-wait`, `resume --no-wait`, and `stop --no-wait` each synchronized through `sandbox wait --status ...`.
- **PASS:** isolated-profile re-login preserved the test-yellow base URL; profile state and the logged-out diagnostic were correct.
- **FAIL (backend blocker):** deleting a stopped fork and immediately deleting its stopped parent still returned the dependent-fork 409. Retrying after ten seconds succeeded.
- **PASS:** ordinary PTY `exit` and Ctrl+] both returned within ten seconds. Raw protocol probes proved the runtime had already emitted exit/kill responses; the remaining hang was resumed local stdin keeping the Node process alive after shell cleanup.
- **PASS:** all remediation-created sandboxes were removed after the retest.

Release remains blocked until the API-types update, fork-deletion consistency fix, and the remaining test-yellow retest all pass.
