# Sandbox CLI QA report

**Date:** 2026-08-20
**Stack:** [PR #49 — named profiles](https://github.com/archil-data/archil-sdk/pull/49) → [PR #56 — sandbox CLI](https://github.com/archil-data/archil-sdk/pull/56)
**Live-tested commit:** `1f0b54067df5f5245ead5d533b4b46f59ae5b534` (subsequently rebased without changing the tested sandbox behavior)
**Live environment:** test yellow (`aws-us-east-1`) using the configured `test-yellow` profile

## Verdict

**Do not release the stack as-is.** Core create, execution, PTY, lifecycle, profile, packaging, and fork data-integrity workflows passed. Reliable fork cleanup remains blocked by backend consistency: after deleting a fork, its parent remained undeletable for roughly 47 seconds even though the child and its disk already returned 404.

A `fork --no-wait` request also returned a 504 with no child ID, and the source was later found paused. The test did not inspect the source between that failed request and the successful retry, so it does not prove that a successful running-source fork leaves its source paused. It does show that the failed fork path did not provide a clear atomic outcome.

## Findings

### 1. A deleted fork blocks parent deletion for roughly 47 seconds

**Severity:** blocker for reliable cleanup

Deleting the stopped fork succeeded and it immediately disappeared from `sandbox list`. The referenced child disk also returned 404 through the disk CLI. Parent deletion nevertheless returned:

```console
Error (409): sandbox has dependent forks: delete 1 child sandbox disk first: dsk-...
```

Retries after 2, 5, and 10 seconds returned the same 409. Parent deletion succeeded after waiting another 30 seconds, roughly 47 cumulative seconds after child deletion.

Fix dependency cleanup synchronously in the control plane. A CLI retry would mask the consistency bug, make `delete` unexpectedly slow, and still leave callers uncertain about a safe retry policy.

### 2. Failed `fork --no-wait` did not provide a clear atomic outcome

**Severity:** high for automation

The source was `running` before the first fork request. That request returned:

```console
Error (504): Sandbox request timed out; retry
```

It returned no child ID, and no matching child appeared after checks at 0, 2, 5, and 10 seconds. An identical retry returned a pending fork immediately and eventually succeeded. The source was later found `paused` and had to be resumed manually.

The test did not query the source between the 504 and retry. A successful fork from an already-paused source is expected to leave it paused, so the evidence does not attribute the final state to the successful retry. The backend contract says a running source is resumed after its fork checkpoint. The most likely sharp edge is therefore the failed request: it may have paused the source before timing out, without returning a child or restoring/reporting the source state.

Add an integration test that forces cancellation or timeout after source checkpointing and proves that the operation either completes with a child ID or restores the source. Also assert that `wait=false` does not consume a synchronous checkpoint wait budget large enough to trigger an edge timeout.

#### Paused command behavior

The observed message:

```console
Cannot run a command in sandbox 'qa-cli-0820191248' while it is paused
```

is generated locally by the CLI's `sandbox.status !== "running"` guard. Removing that guard would not currently make the command wake the sandbox: the SDK starts processes through `POST /api/sandboxes/{sid}/connections`, and the control plane rejects that endpoint unless the sandbox is `running`.

Automatic wake is implemented for public sandbox **service routes**. Those routes resume a paused sandbox or cold-boot another inactive state before proxying service traffic. Generic SDK process connections, `sandbox run`, and `sandbox shell` do not use that route-wake path. Supporting implicit wake for commands would require an explicit resume-and-wait policy in the SDK/CLI or a backend contract change.

### 3. Process-limit rejection exposes an internal runtime message

**Severity:** low UX

A sandbox created with `--max-concurrent-processes 3` ran three simultaneous three-second commands successfully. The fourth correctly failed quickly, but stderr was:

```text
max_concurrent_execs_reached: max_concurrent_execs reached (3/3) for container ...
```

Translate this to CLI terminology, for example: `Sandbox process limit reached (3/3); retry after another process exits.` The current message leaks backend snake_case and says `container` instead of `sandbox`.

### 4. One-second wait timeout uses plural grammar

**Severity:** low polish

```text
Timed out after 1 seconds waiting for sandbox ...
```

Use `1 second`, matching the `sandbox run --timeout 1` diagnostic.

## Live workflows tested

### Creation, validation, and output

- Created a 1-vCPU, 512 MiB sandbox with a 30-minute TTL, process limit 3, and repeated environment variables using `--no-wait`.
- `sandbox wait --status running` synchronized the pending sandbox in about two seconds.
- Confirmed the requested CPU, memory, TTL, process limit, image, and environment values in JSON output.
- Created a sandbox without a name and resolved its server-generated name through `wait`.
- Verified table and JSON list/get output.
- Rejected out-of-range CPU and memory, invalid names, invalid environment names, invalid output formats, missing targets, and invalid wait statuses before unintended creation.
- Confirmed duplicate names are rejected by the control plane with HTTP 409.

### Command execution

- Preserved direct argv values containing spaces, empty strings, semicolons, dollar signs, single and double quotes, and embedded newlines.
- Preserved explicit `sh -c` positional arguments.
- Preserved create-time environment variables and per-run overrides, including empty and spaced values.
- Routed stdout and stderr independently.
- Propagated remote exit code 7 to the local process.
- Timed out `sleep 5` after a one-second timeout with a visible diagnostic and exit 1.
- Streamed exactly 1 MiB of output; its local SHA-256 matched the expected payload.
- Enforced `maxConcurrentProcesses=3`: three concurrent jobs succeeded and the fourth was rejected.

### Interactive PTY

Tested through a real PTY using `pexpect`:

- Opened `sandbox shell`, ran a command, and exited normally with status 0 in 0.35 seconds.
- Opened a second shell and used Ctrl+]; the CLI returned status 1 in 0.24 seconds.

### Lifecycle and synchronization

- Exercised pause, resume, paused cold-start confirmation, cold start with `--yes`, stop, and start.
- Exercised `--no-wait` plus targeted `sandbox wait` for running, paused, and stopped states.
- Confirmed wrong-state operations fail without making an API request.
- Confirmed a targeted wait times out with the current state in its diagnostic.
- Confirmed disk data survives a paused cold start.

### Fork data integrity

- Seeded text and 4 KiB of random binary data before forking.
- Verified matching SHA-256 values in parent and fork.
- Verified file mode `0640` was preserved.
- Modified the fork and confirmed the parent remained unchanged.
- Observed the failed-fork outcome and deletion-consistency findings above.

### Profiles and credentials

Using an isolated configuration directory and the test-yellow credential:

- Performed headless login from stdin.
- Listed live sandboxes through the isolated profile.
- Used the same profile through the `disk` CLI, confirming cross-CLI profile sharing.
- Re-logged in with omitted region/base URL and confirmed saved values were preserved.
- Logged out and received a profile-specific missing-key diagnostic.
- Deleted the isolated profile.
- Confirmed configuration and credential files used mode `0600`; directories used `0700`.
- After the follow-up fix, confirmed nested `auth login`/`auth logout` help for both binaries displays inherited `--api-key`, `--region`, `--base-url`, and `--profile` options under `Global Options`.

### Packaging

- Confirmed the build produces executable `dist/cli.mjs` and `dist/sandbox-cli.mjs` files.
- Confirmed the package dry-run includes `dist/sandbox-cli.mjs`.
- Packed the package and installed it into a clean temporary npm project.
- Confirmed both `disk` and `sandbox` bin links worked, reported version `0.11.0`, and exposed the expected create options.

## Recommended test coverage

1. Add a live integration test proving fork `wait=false` responds immediately and returns an accepted child ID without a server wait timeout.
2. Force cancellation after source checkpointing and assert that the source is restored when no child is returned.
3. Assert the source sandbox's post-fork state for running, paused, and stopped sources.
4. Add a control-plane test requiring parent deletion to succeed as soon as child deletion returns success.
5. Test process-limit error translation at the CLI boundary.
6. Cover singular and plural wait-timeout diagnostics.

## Cleanup evidence

The session created one parent, one fork, and one independent generated-name sandbox. The fork and independent sandbox deleted immediately. The parent hit the dependency race but was eventually deleted after the 30-second retry. A final test-yellow query returned zero names starting with `qa-cli-`; the pre-existing `cargo-build-compare-0819-223735` sandbox was untouched.

## Automated verification

```text
pnpm run build                         PASS
pnpm run typecheck                     PASS
pnpm run test                          PASS (disk: 16 files, 116 tests)
pnpm --filter disk pack --dry-run      PASS
clean tarball npm install              PASS
git diff --check                       PASS
git diff main...HEAD --check           PASS
```
