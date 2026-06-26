# @archildata/just-bash

> **Not recommended for new projects.** With Archil's serverless execution (`disk <id> exec <command>`, or `Disk.exec()` from the [`disk`](https://www.npmjs.com/package/disk) package), you can run commands against your disk without standing up a client-side mount or bash environment at all — the command runs in an Archil-managed container with the disk pre-mounted and returns stdout/stderr/exit code. We no longer recommend `@archildata/just-bash`; reach for `disk exec` instead.
>
> This package is still published for existing users who have tooling built around it.

Run bash commands against your cloud storage through [Archil](https://archil.com) — no local mount required. Works in scripts, CI pipelines, and interactive sessions.

## Quick Start

If you already have an Archil disk set up (see [`disk`](https://www.npmjs.com/package/disk) for setup), you can start a shell in one command:

```bash
ARCHIL_DISK_TOKEN=my-secret-mount-token npx @archildata/just-bash aws-us-east-1 myaccount/my-disk
```

This drops you into an interactive shell. The files you see are the contents of your cloud bucket:

```
$ ls
data/  logs/  config.json

$ cat config.json
{"version": 2, "debug": false}

$ echo "hello from archil" > greeting.txt
```

Everything you do here — reads, writes, renames, deletes — goes through Archil to your bucket.

## Using in Your Code

The interactive shell is great for poking around, but you can also run bash commands from your own code. This is useful for scripts, CI pipelines, AI agents, or anywhere you want to run shell commands against your cloud storage.

```bash
npm install @archildata/just-bash @archildata/native just-bash
```

```typescript
import { ArchilClient } from '@archildata/native';
import { ArchilFs, createArchilCommand } from '@archildata/just-bash';
import { Bash } from 'just-bash';

// Connect to your disk
const client = await ArchilClient.connect({
  region: 'aws-us-east-1',
  diskName: 'myaccount/my-disk',
  authToken: 'my-secret-mount-token',
});

// Create a filesystem adapter and a bash executor
const fs = await ArchilFs.create(client);
const bash = new Bash({
  fs,
  customCommands: [createArchilCommand(client, fs)],
});

// Run commands just like you would in a terminal
const result = await bash.exec('ls -la /');
console.log(result.stdout);

// Write a file
await bash.exec('echo "hello world" > /greeting.txt');

// Read it back
const cat = await bash.exec('cat /greeting.txt');
console.log(cat.stdout); // "hello world"

// Clean up
await client.close();
```

## Using the Filesystem Adapter Directly

If you don't need bash and just want standard file operations, you can use `ArchilFs` on its own. It works like Node.js `fs`:

```typescript
const fs = await ArchilFs.create(client);

await fs.writeFile('/notes.txt', 'some content');
const content = await fs.readFile('/notes.txt');
const entries = await fs.readdir('/');
const stats = await fs.stat('/notes.txt');
await fs.mkdir('/mydir', { recursive: true });
await fs.cp('/notes.txt', '/mydir/notes-copy.txt');
await fs.rm('/notes.txt');
```

## Writing Files (Delegations)

Archil uses a delegation system for writes. When multiple clients connect to the same disk, delegations coordinate who can write to what. Before writing to a file or directory, you "check out" a delegation on it. When you're done, you "check in" to release it.

In the interactive shell, use the built-in `archil` command:

```
$ archil checkout /mydir
$ echo "hello" > /mydir/newfile.txt
$ archil checkin /mydir
```

In code, use the client directly:

```typescript
const inodeId = await fs.resolveInodeId('/mydir');
await client.checkout(inodeId);

await bash.exec('echo "hello" > /mydir/newfile.txt');

await client.checkin(inodeId);
```

## Subdirectory Mounting

You can mount a subdirectory of a disk instead of the root. This is useful when your bucket has a project nested inside it:

```bash
ARCHIL_DISK_TOKEN=my-secret-mount-token npx @archildata/just-bash aws-us-east-1 myaccount/my-disk:/data/project
```

## Interactive Shell Reference

```bash
# Basic usage
npx @archildata/just-bash <region> <org>/<disk>

# With mount token
ARCHIL_DISK_TOKEN=xxx npx @archildata/just-bash aws-us-east-1 myaccount/my-disk

# With subdirectory
npx @archildata/just-bash aws-us-east-1 myaccount/my-disk:/path/to/subdir

# With debug logging
npx @archildata/just-bash aws-us-east-1 myaccount/my-disk --log-level debug
```

Shell commands:
- Standard bash commands (`ls`, `cat`, `echo`, `cp`, `mv`, `rm`, etc.)
- `archil checkout [--force] <path>` — acquire write delegation
- `archil checkin <path>` — release write delegation
- `archil list-delegations` — show currently held delegations
- `archil help` — show archil commands

## Platform Support

Requires **Linux** (x64 or arm64, glibc) or **macOS** (Apple Silicon / arm64) for the native filesystem client.

## Support

Questions, feature requests, or issues? Reach us at **support@archil.com**.
