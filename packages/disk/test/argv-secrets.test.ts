// An API key passed as `--api-key <key>` is readable by every local user in
// /proc/<pid>/cmdline. The CLI entry points scrub it from the process's argv
// memory and warn; `--api-key -` reads the key from stdin instead.

import { test } from "vitest";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  API_KEY_ARGV_WARNING,
  protectApiKeyArgument,
  redactApiKeyArgs,
} from "../src/cli/argv-secrets.js";
import { resolveCliCredentials } from "../src/cli/credentials.js";
import { credentialOptions } from "../src/cli/completion.js";

test("redacts every form of a command-line API key, up to --", () => {
  assert.deepEqual(
    redactApiKeyArgs(["disk", "--api-key", "key-a", "list", "--api-key=key-b", "-k", "key-c", "-kkey-d", "--", "-k", "remote"]),
    { args: ["disk", "--api-key", "***", "list", "--api-key=***", "-k", "***", "-k***", "--", "-k", "remote"], redacted: true },
  );
});

test("leaves stdin markers and key-free command lines alone", () => {
  assert.deepEqual(redactApiKeyArgs(["disk", "-k", "-", "list"]), { args: ["disk", "-k", "-", "list"], redacted: false });
  assert.deepEqual(redactApiKeyArgs(["disk", "--api-key=-", "list"]), { args: ["disk", "--api-key=-", "list"], redacted: false });
  assert.deepEqual(redactApiKeyArgs(["disk", "--region", "r", "list"]), { args: ["disk", "--region", "r", "list"], redacted: false });
  assert.deepEqual(redactApiKeyArgs(["disk", "list", "--api-key"]), { args: ["disk", "list", "--api-key"], redacted: false });
});

test("protectApiKeyArgument rewrites the title and warns only when a key was passed", () => {
  const titles: string[] = [];
  let written = "";
  const stderr = { write: (value: string) => { written += value; } };
  const setTitle = (title: string) => { titles.push(title); };

  assert.equal(protectApiKeyArgument(["node", "/bin/disk", "--api-key", "key-secret", "list"], { setTitle, stderr }), true);
  assert.equal(titles.length, 1);
  assert.ok(!titles[0]!.includes("key-secret"));
  assert.ok(titles[0]!.endsWith("/bin/disk --api-key *** list"));
  assert.equal(written, API_KEY_ARGV_WARNING);

  assert.equal(protectApiKeyArgument(["node", "/bin/disk", "-k", "-", "list"], { setTitle, stderr }), false);
  assert.equal(protectApiKeyArgument(["node", "/bin/archil", "__complete", "-k", "key-x"], { setTitle, stderr, warn: false }), true);
  assert.equal(titles.length, 2);
  assert.equal(written, API_KEY_ARGV_WARNING);
});

test("the key no longer appears in /proc/<pid>/cmdline", { skip: !existsSync("/proc/self/cmdline") }, () => {
  const fixture = fileURLToPath(new URL("./fixtures/print-cmdline.mjs", import.meta.url));
  const cmdline = execFileSync(process.execPath, [fixture, "--region", "aws-us-east-1", "--api-key", "key-0123456789abcdef", "list"], {
    stdio: ["ignore", "pipe", "pipe"],
  }).toString("utf8");
  assert.ok(!cmdline.includes("key-0123456789abcdef"), JSON.stringify(cmdline));
  assert.match(cmdline, /--api-key \*\*\* list/);
});

test("--api-key - reads the key from stdin", async () => {
  const profiles = { profiles: {} };
  const resolved = await resolveCliCredentials({ apiKey: "-", region: "aws-us-east-1" }, profiles, {}, undefined, async () => "key-from-stdin");
  assert.equal(resolved.apiKey, "key-from-stdin");
  // ARCHIL_API_KEY=- means the same thing.
  const fromEnv = await resolveCliCredentials({ region: "aws-us-east-1" }, profiles, { ARCHIL_API_KEY: "-" }, undefined, async () => "key-env-stdin");
  assert.equal(fromEnv.apiKey, "key-env-stdin");
  // A literal key never touches stdin.
  const literal = await resolveCliCredentials({ apiKey: "key-literal", region: "r" }, profiles, {}, undefined, async () => { throw new Error("read stdin"); });
  assert.equal(literal.apiKey, "key-literal");
});

test("tab completion ignores -k - instead of blocking on stdin", () => {
  assert.deepEqual(credentialOptions(["-k", "-", "-r", "aws-us-east-1", "sandbox", "ssh"]), { region: "aws-us-east-1" });
});
