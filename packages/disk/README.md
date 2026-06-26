# disk

Node.js client and CLI for [Archil](https://archil.com) disks. Create disks, list and inspect them, manage who can mount them, and run commands against them — all from scripts, CI, or an interactive terminal. It also ships **drop-in [agent tools](#agent-tools)** that turn a disk into a ready-made filesystem toolset for the Vercel AI SDK, Mastra, LangChain, and other frameworks.

`disk` talks to the Archil control plane over HTTPS and has no native dependencies. If you also want to mount a disk's data plane from Node (rare — most users want `disk exec` or the `archil` CLI), install [`@archildata/native`](https://www.npmjs.com/package/@archildata/native) alongside `disk`.

## Install

```bash
npm install disk
```

## CLI

```bash
# Authenticate
export ARCHIL_API_KEY=key-...
export ARCHIL_REGION=aws-us-east-1

# Create a disk — the response includes a one-time disk token you'll need to mount it
npx disk create my-disk

# List and inspect
npx disk list
npx disk get dsk-abc123

# Run a command against the disk's contents — Archil spins up a container with the disk
# mounted, runs the command, and returns stdout/stderr/exit code.
npx disk dsk-abc123 exec "ls -la /mnt"

# Delete
npx disk delete dsk-abc123

# Manage account-level API keys
npx disk api-keys list
npx disk api-keys create ci-bot
npx disk api-keys delete key-abc123
```

`list` and `get` pretty-print tables by default; pass `-o json` to pipe into `jq`. Credentials come from `ARCHIL_API_KEY` / `ARCHIL_REGION`, or `--api-key` / `--region` / `--base-url` flags.

## Library

The recommended pattern is a module-namespace import:

```ts
import * as archil from "disk";

// Configure once per process — falls back to ARCHIL_API_KEY / ARCHIL_REGION env vars.
archil.configure({ apiKey: process.env.ARCHIL_API_KEY, region: "aws-us-east-1" });

// Create a disk. `token` here is the disk token — the one-time credential for mounting.
const { disk, token } = await archil.createDisk({ name: "my-disk" });
console.log(`Created ${disk.id}, disk token: ${token}`);

// List and look up disks
const all = await archil.listDisks();
const d = await archil.getDisk(disk.id);
```

Per-disk operations are methods on the `Disk` object itself, not top-level functions:

```ts
const d = await archil.getDisk("dsk-abc123");

// Run a command in a container with the disk mounted
const { stdout, stderr, exitCode } = await d.exec("ls -la /mnt && cat /mnt/config.json");

// Manage who can mount the disk
const user = await d.addUser({ type: "token", nickname: "ci" });
await d.removeUser("token", user.identifier!);

// Delete
await d.delete();
```

API keys live at the account level, so those helpers are top-level:

```ts
await archil.listApiKeys();
await archil.createApiKey({ name: "ci-bot", description: "GitHub Actions" });
await archil.deleteApiKey("key-abc123");
```

### Reading and writing objects

A `Disk` doubles as an S3-compatible bucket: read, write, delete, and list its
files by key without mounting it. These methods talk to Archil's S3 endpoint
using your same API key (no separate S3 credentials or SigV4 signing on your
part).

```ts
const d = await archil.getDisk("dsk-abc123");

// Write — accepts a string, Uint8Array/Buffer, or ArrayBuffer. Returns the etag.
const { etag } = await d.putObject("reports/2026-01/data.json", JSON.stringify(report), "application/json");

// Read — returns the bytes (a Uint8Array).
const bytes = await d.getObject("reports/2026-01/data.json");
const text = new TextDecoder().decode(bytes);

// Metadata / existence without downloading the body
const meta = await d.headObject("reports/2026-01/data.json"); // null if absent
if (await d.objectExists("reports/2026-01/data.json")) { /* … */ }

// Delete (idempotent — deleting a missing key succeeds)
await d.deleteObject("reports/2026-01/data.json");
```

`listObjects` auto-paginates by default, returning every matching key. The first
argument is a key prefix; a non-recursive listing (the default) returns the
immediate level as `objects` plus subdirectory `commonPrefixes`:

```ts
const { objects, commonPrefixes } = await d.listObjects("reports/");      // one level
const all = await d.listObjects("reports/", { recursive: true });          // whole subtree
const first100 = await d.listObjects("reports/", { limit: 100 });          // cap the total

// Stream pages instead of buffering everything (large listings):
for await (const page of d.listObjectsPages("reports/")) {
  for (const obj of page.objects) console.log(obj.key, obj.size, obj.lastModified);
}

// Or drive pagination yourself:
const page = await d.listObjects("reports/", { singlePage: true });
if (page.isTruncated) {
  const next = await d.listObjects("reports/", { singlePage: true, continuationToken: page.nextContinuationToken });
}
```

### Large uploads and bulk delete

`putObject` handles any size with one call. Small bodies go through a single
request; large ones are uploaded as a multipart upload automatically — split into
parts, uploaded with bounded concurrency, and assembled, aborting the upload if
any part fails so nothing is left half-staged. You don't pick a different method
for big files. For very large objects the part size is grown automatically so the
upload never exceeds S3's 10,000-part limit.

```ts
// Small or multi-gigabyte — same call.
await d.putObject("reports/2026-01/data.json", JSON.stringify(report), "application/json");

const { etag } = await d.putObject("backups/2026-01.tar", bigBytes, {
  contentType: "application/x-tar",
  multipartThreshold: 5 * 1024 * 1024, // switch to multipart above 5 MiB; default = partSize
  partSize: 32 * 1024 * 1024,          // ≥ 5 MiB; default 16 MiB
  concurrency: 8,                      // parts in flight at once; default 4
});
```

For manual control over the multipart lifecycle (e.g. uploading parts from
separate processes), the raw S3 primitives live in the opt-in `d.multipart`
namespace — `create`, `uploadPart`, `complete`, `abort`, `listParts`,
`listUploads`. Most code never needs these.

```ts
const { uploadId } = await d.multipart.create("big.bin");
const p1 = await d.multipart.uploadPart("big.bin", uploadId, 1, firstChunk);
const p2 = await d.multipart.uploadPart("big.bin", uploadId, 2, secondChunk);
await d.multipart.complete("big.bin", uploadId, [p1, p2]);
```

`deleteObjects` removes many keys in one round trip (auto-batched at S3's 1000-key
limit). Unlike `deleteObject`, per-key failures are returned rather than thrown:

```ts
const { deleted, errors } = await d.deleteObjects(["a.txt", "logs/b.txt", "c.txt"]);
for (const e of errors) console.warn(`${e.key}: ${e.code} ${e.message}`);
```

`appendObject` appends bytes to an existing object (creating it if absent) — handy
for log-style writes. Each call may append at most 1 MiB; append in chunks to grow
past that.

```ts
await d.appendObject("logs/app.log", "first line\n");
await d.appendObject("logs/app.log", "second line\n"); // concatenated
```

Transient failures (HTTP 429 and 5xx, plus network errors) are retried
automatically with jittered exponential backoff before surfacing; caller errors
(other 4xx) are not retried. The two non-idempotent operations —
`completeMultipartUpload` and `appendObject` — are *not* auto-retried, since a
retry after a succeeded-but-unacknowledged call would return a spurious
`NoSuchUpload` (complete) or duplicate the appended bytes (append).

Failures throw `ArchilS3Error` with `status` (HTTP status), `code` (the S3 error
code, e.g. `"NoSuchKey"`), `requestId`, and the raw body on `raw`. `getObject`
on a missing key throws a 404 — use `headObject`/`objectExists` to probe without
catching. All SDK errors extend `ArchilError`, so `catch (e) { if (e instanceof
ArchilError) … }` handles control-plane and S3 failures uniformly.

The S3 endpoint is derived from your region automatically. To target a custom
environment, set `s3BaseUrl` on the `Archil` constructor (or the
`ARCHIL_S3_BASE_URL` env var).

### Sharing files

`share` mints a signed, time-limited link to a single file. Anyone with the link
can download that file — no API key, no mounting. The link carries a
cryptographically signed token (disk + key + expiry); when it expires it stops
working.

```ts
const d = await archil.getDisk("dsk-abc123");

// Default lifetime is 24 hours.
const { url, expiresIn } = await d.share("reports/2026-01/summary.pdf");
console.log(url); // https://control.…/api/shared/<token>

// Set the lifetime in seconds (any positive integer, up to 604800 = 7 days):
const weekLink = await d.share("reports/2026-01/summary.pdf", { expiresIn: 604800 });
```

### Named imports

If you prefer named imports over the namespace style, they work the same way:

```ts
import { createDisk, getDisk, listDisks, configure } from "disk";
```

### Multiple accounts or regions

For multi-tenant scripts, instantiate `Archil` directly instead of using the module-level `configure`:

```ts
import { Archil } from "disk";

const prod = new Archil({ apiKey: prodKey, region: "aws-us-east-1" });
const staging = new Archil({ apiKey: stagingKey, region: "aws-us-east-1" });

const prodDisks = await prod.disks.list();
const stagingDisks = await staging.disks.list();
```

## Agent tools

Turn a disk — or a multi-disk **workspace** — into a ready-made filesystem
toolset for popular agent frameworks, so you can hand an LLM a real filesystem
to work in. The agent gets six tools: `read_file`, `write_file`,
`delete_file`, `list_files`, `grep`, and `run_bash` (an arbitrary command in a
container with the disk mounted). Import the adapter for your framework from a
subpath, so you only pull in the framework you use:

```ts
import * as archil from "disk";
import { agentTools } from "disk/ai-sdk"; // Vercel AI SDK
import { generateText } from "ai";

const d = await archil.getDisk("dsk-abc123");

// Single disk → a ToolSet. The disk is the filesystem root (/).
const result = await generateText({ model, prompt, tools: agentTools(d) });
```

Or span several disks in one **workspace** (the same shape as `exec`'s mounts).
Each disk is a top-level directory (e.g. `/data/…`, `/cache/…`); file operations
route to the right disk by path, and `grep` / `listFiles` fan out across all of
them. `run_bash` starts at the common root, so relative paths line up:

```ts
import { agentTools } from "disk/mastra";

const ws = archil.workspace({ data: diskA, cache: diskB });
const tools = agentTools(ws); // hand to a Mastra Agent
```

Multi-disk exec mounts can request delegations before the command starts:

```ts
await archil.exec({
  command: "npm test",
  disks: {
    data: {
      disk: diskA,
      checkoutPaths: ["src", "tmp/cache"],
      queueMs: 5_000,
    },
  },
});
```

When `queueMs` is set without `checkoutPaths`, the mount root is acquired
during mount setup instead.

A `Workspace` is a full filesystem in its own right — it has the same object API
a `Disk` does (`getObject` / `putObject` / `deleteObject` / `listObjects` /
`grep` / `exec`; both implement the `FileSystem` interface), so you can use it
directly without the agent tools, and add or remove disks at runtime. A
workspace's keys carry the disk name as their first segment:

```ts
const data = await ws.getObject("data/reports/q1.csv"); // routes to the "data" disk
ws.addDisk("scratch", diskTmp); // mount another disk live; ws.removeDisk("scratch")
```

Pick the subpath for your framework — each returns that framework's native tool
type:

| Import | Framework | Returns |
| --- | --- | --- |
| `disk/ai-sdk` | Vercel AI SDK | `ToolSet` |
| `disk/mastra` | Mastra | record of tools |
| `disk/langchain` | LangChain / LangGraph | `StructuredToolInterface[]` |

The frameworks are optional peer dependencies — install whichever you use
(`npm install ai`, `@mastra/core`, or `@langchain/core`). Expose a subset of
tools with `agentTools(d, { tools: ["read_file", "grep"] })`, and give an agent
read-only access to a disk in a workspace by mounting it with `{ disk, readOnly:
true }` — `write_file` / `delete_file` then return an error instead of mutating
it.

## Connecting to a disk's data plane

To run a command against a disk, use `Disk.exec()` — it returns stdout, stderr, and an exit code from an Archil-managed container with the disk pre-mounted. No local filesystem involved.

To mount a disk as a real filesystem on your machine, use the [`archil`](https://archil.com) CLI — it mounts through the OS kernel via FUSE, so any program can read and write files with standard APIs.

For the rare case where you need raw Archil protocol access from Node.js (inodes, delegations, byte-level reads), install [`@archildata/native`](https://www.npmjs.com/package/@archildata/native) alongside `disk`:

```bash
npm install disk @archildata/native
```

Then `Disk.mount()` lazy-loads the native client:

```ts
import { getDisk } from "disk";

const d = await getDisk("dsk-abc123");
const client = await d.mount({ authToken: "<disk-token>" });
// `client` is an ArchilClient from @archildata/native — see that package's README.
await client.close();
```

`@archildata/native` supports Linux (x64 / arm64, glibc) and macOS (arm64). On other platforms, `mount()` throws; the rest of `disk` still works.

## Supported regions

| Region            | Provider |
| ----------------- | -------- |
| `aws-us-east-1`   | AWS      |
| `aws-us-west-2`   | AWS      |
| `aws-eu-west-1`   | AWS      |
| `gcp-us-central1` | GCP      |

## FAQ

### What's the difference between an API key and a disk token?

Archil has two credential types, and the examples above use both:

- **API key** — account-level credential for the control plane. You use one whenever you call `disk` (CLI or library). Create and manage them at [console.archil.com](https://console.archil.com) or with `disk api-keys create`. Goes in the `ARCHIL_API_KEY` env var or the `--api-key` flag.
- **Disk token** — per-disk credential that lets a client mount a specific disk. Created automatically when you `disk create <name>` (the value is shown once; save it). You don't need one to run `disk` itself — only when something is actually mounting a disk.

## Support

Questions, feature requests, or issues? Reach us at **support@archil.com**.
