import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import {
  loginProfileName,
  createArchilProgram,
  findNativeClient,
  firstCommand,
  forwardToNativeClient,
  isNativeCommand,
} from "../src/cli/archil-command.js";
import { rewriteDiskExecSugar } from "../src/cli/disk-command.js";
import { createSandboxProgram } from "../src/cli/sandbox-command.js";
import { printError } from "../src/cli/ui.js";
import { ArchilApiError } from "../src/errors.js";
import type { Sandbox } from "../src/sandbox.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "archil-cli-test-"));
  vi.stubEnv("ARCHIL_DISK_CONFIG_DIR", join(directory, "config"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

async function executable(path: string, contents: string): Promise<string> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, contents);
  await chmod(path, 0o755);
  return path;
}

test("commands this CLI doesn't own go to the native client", () => {
  assert.equal(firstCommand(["--profile", "prod", "sandbox", "list"]), "sandbox");
  assert.equal(firstCommand(["-r", "aws-us-east-1", "--api-key=k", "disk", "list"]), "disk");
  assert.equal(firstCommand(["--help"]), undefined);
  assert.equal(isNativeCommand(["sandbox", "list"]), false);
  assert.equal(isNativeCommand(["--profile", "mount", "profile", "list"]), false);
  assert.equal(isNativeCommand(["help", "mount"]), false);
  assert.equal(isNativeCommand([]), false);
  assert.equal(isNativeCommand(["mount", "dsk-1", "/mnt/data"]), true);
  assert.equal(isNativeCommand(["--region", "x", "unmount", "/mnt/data"]), true);
});

test("the native client is found on PATH, skipping this CLI and other node copies of it", async () => {
  const self = await executable(join(directory, "self", "archil.mjs"), "#!/usr/bin/env node\n");
  await mkdir(join(directory, "npm-bin"));
  await symlink(self, join(directory, "npm-bin", "archil"));
  await executable(join(directory, "other-copy", "archil"), "#!/usr/bin/env -S node --no-warnings\n");
  const native = await executable(join(directory, "native", "archil"), "\x7fELF native binary");
  const later = await executable(join(directory, "later", "archil"), "#!/bin/sh\necho later\n");

  const path = ["npm-bin", "other-copy", "native", "later"].map((name) => join(directory, name)).join(delimiter);
  assert.equal(findNativeClient({ PATH: path }, join(directory, "npm-bin", "archil")), native);
  const withoutNative = ["npm-bin", "other-copy", "later"].map((name) => join(directory, name)).join(delimiter);
  assert.equal(findNativeClient({ PATH: withoutNative }, self), later, "a shell wrapper still counts as the native client");
  assert.equal(findNativeClient({ PATH: join(directory, "npm-bin") }, self), undefined);
});

test("forwarding runs the native client with the same arguments and exit code", async () => {
  const native = await executable(join(directory, "native", "archil"), `#!/bin/sh\n[ -n "$ARCHIL_CLI_FORWARD_SKIP" ] || exit 9\n[ "$1 $2" = "mount dsk-1" ] && exit 3\nexit 1\n`);
  const env = { PATH: join(directory, "native") };
  assert.equal(await forwardToNativeClient(["mount", "dsk-1"], env, join(directory, "self.mjs")), 3);
  await assert.rejects(forwardToNativeClient(["mount"], { PATH: "" }, join(directory, "self.mjs")), /curl https:\/\/archil\.com\/install \| sh/);
});

test("a non-node wrapper of this CLI is skipped on the next hop instead of looping", async () => {
  // pnpm installs bins as sh scripts that exec node; they don't look like node scripts.
  const shim = await executable(join(directory, "pnpm-bin", "archil"), "#!/bin/sh\nexec node archil.mjs \"$@\"\n");
  const native = await executable(join(directory, "native", "archil"), "\x7fELF native");
  const path = [join(directory, "pnpm-bin"), join(directory, "native")].join(delimiter);
  const self = join(directory, "self.mjs");
  assert.equal(findNativeClient({ PATH: path }, self), shim, "first hop can't tell the shim apart");
  // The shim re-runs this CLI with the skip list from the first hop.
  assert.equal(findNativeClient({ PATH: path, ARCHIL_CLI_FORWARD_SKIP: [self, shim].join(delimiter) }, self), native);
  assert.equal(findNativeClient({ PATH: path, ARCHIL_CLI_FORWARD_SKIP: [shim, native].join(delimiter) }, self), undefined);
});

test("archil nests the sandbox commands and reads global options given before them", async () => {
  const sandbox = { id: "0198aabb-1234-7abc-8def-0123456789ab", name: "one", status: "running", lastActiveAt: new Date(), vcpuCount: 1, memSizeMiB: 256, baseImage: "x" } as unknown as Sandbox;
  const createClient = vi.fn((_options: { apiKey?: string; region?: string }) => ({ sandboxes: { list: async () => [sandbox], get: async () => sandbox, create: async () => sandbox } }));
  const stdout = { values: [] as string[], write(data: string) { this.values.push(data); return true; } };
  const program = createArchilProgram({ version: "test", createClient, stdout, stderr: { write: () => true } });
  await program.parseAsync(["node", "archil", "--api-key", "key-test", "--region", "aws-us-east-1", "sandbox", "list", "-o", "json"]);
  assert.equal(createClient.mock.calls.length, 1);
  assert.equal(createClient.mock.calls[0]![0].apiKey, "key-test");
  assert.equal(createClient.mock.calls[0]![0].region, "aws-us-east-1");
  assert.equal(JSON.parse(stdout.values.join(""))[0].name, "one");
});

test("disk exec sugar is rewritten after the disk command word", () => {
  assert.deepEqual(rewriteDiskExecSugar(["node", "disk", "dsk-1", "exec", "ls"]), ["node", "disk", "exec", "dsk-1", "ls"]);
  assert.deepEqual(
    rewriteDiskExecSugar(["node", "archil", "disk", "dsk-1", "exec", "ls"], 3),
    ["node", "archil", "disk", "exec", "dsk-1", "ls"],
  );
  assert.deepEqual(rewriteDiskExecSugar(["node", "disk", "list", "exec"]), ["node", "disk", "list", "exec"]);
});

test("login never overwrites a profile someone created by hand", () => {
  const acme = { region: "aws-us-east-1", account: "Acme" };
  assert.equal(loginProfileName({}, acme), "acme");
  const manual = { acme: { region: "aws-us-east-1" } };
  assert.equal(loginProfileName(manual, acme), "acme-2");
  const relogin = { ...manual, "acme-2": { region: "aws-us-east-1", apiKeyId: "tok-1", account: "Acme" } };
  assert.equal(loginProfileName(relogin, acme), "acme-2", "a later login replaces the same account's profile");
  assert.equal(loginProfileName(relogin, { region: "aws-us-west-2", account: "Acme" }), "acme-2", "even when its default region changed");
  assert.equal(loginProfileName(relogin, { region: "aws-us-east-1", account: "Other Co" }), "other-co", "another account gets its own");
  assert.equal(loginProfileName(relogin, { ...acme, baseUrl: "https://control.example.com" }), "acme-3", "a different endpoint gets its own");
  assert.equal(loginProfileName(relogin, acme, "acme-2"), "acme-2", "--profile may name an earlier login's profile");
  assert.equal(loginProfileName(relogin, acme, "fresh"), "fresh");
  assert.throws(() => loginProfileName(relogin, acme, "acme"), /already exists and wasn't created by 'archil login'/);
  assert.equal(loginProfileName({}, { region: "aws-us-east-1" }), "aws-us-east-1", "no account: named after the region");
  assert.equal(loginProfileName({}, { region: "aws-us-east-1", account: "!!!" }), "aws-us-east-1");
});

test("an account id finds the account's profile even after a rename, and tells same-named accounts apart", () => {
  const profiles = {
    "acme": { region: "aws-us-east-1", apiKeyId: "tok-1", account: "Acme", accountId: "org_1" },
    "legacy": { region: "aws-us-east-1", apiKeyId: "tok-2", account: "Legacy Co" },
  };
  assert.equal(loginProfileName(profiles, { region: "aws-us-east-1", account: "Acme Renamed", accountId: "org_1" }), "acme");
  assert.equal(loginProfileName(profiles, { region: "aws-us-east-1", account: "Acme", accountId: "org_2" }), "acme-2");
  assert.equal(loginProfileName(profiles, { region: "aws-us-east-1", account: "Legacy Co", accountId: "org_3" }), "legacy", "a 0.1.0 profile without an id matches by name");
});

test("the standalone sandbox executable keeps tables when piped; archil switches to JSON", async () => {
  const sandbox = { id: "0198aabb-1234-7abc-8def-0123456789ab", name: "one", status: "running", lastActiveAt: new Date(), vcpuCount: 1, memSizeMiB: 256, baseImage: "x" } as unknown as Sandbox;
  const service = { list: async () => [sandbox], get: async () => sandbox, create: async () => sandbox };
  const piped = () => ({ isTTY: false, values: [] as string[], write(data: string) { this.values.push(data); return true; } });

  const legacyOut = piped();
  const legacy = createSandboxProgram({ version: "test", createClient: () => ({ sandboxes: service }), stdout: legacyOut, stderr: { write: () => true } });
  await legacy.parseAsync(["node", "sandbox", "--api-key", "key-test", "--region", "r", "list"]);
  assert.match(legacyOut.values.join(""), /│ id\s+│ name/, "unchanged: a table, even when piped");

  vi.stubEnv("FORCE_COLOR", "1");
  const forced = piped();
  const legacyForced = createSandboxProgram({ version: "test", createClient: () => ({ sandboxes: service }), stdout: forced, stderr: { write: () => true } });
  await legacyForced.parseAsync(["node", "sandbox", "--api-key", "key-test", "--region", "r", "list"]);
  assert.ok(!forced.values.join("").includes("\x1b["), "never colored, even with FORCE_COLOR");

  const archilOut = piped();
  const archil = createArchilProgram({ version: "test", createClient: () => ({ sandboxes: service }), stdout: archilOut, stderr: { write: () => true } });
  await archil.parseAsync(["node", "archil", "--api-key", "key-test", "--region", "r", "sandbox", "list"]);
  assert.equal(JSON.parse(archilOut.values.join(""))[0].name, "one");
});

test("legacy error output is byte-for-byte the original format", () => {
  const lines: string[] = [];
  const stream = { isTTY: true, write(data: string) { lines.push(data); return true; } };
  printError(new ArchilApiError("No disk found with name 'x'", 404), stream, "disk", { legacy: true });
  printError(new Error("Missing API key: pass --api-key, set ARCHIL_API_KEY, or run 'profile create'"), stream, "sandbox", { legacy: true });
  assert.deepEqual(lines, [
    "Error (404): No disk found with name 'x'\n",
    "Missing API key: pass --api-key, set ARCHIL_API_KEY, or run 'profile create'\n",
  ]);
});

test("a command group without a subcommand prints its help plainly, not as an error", () => {
  const lines: string[] = [];
  const stream = { isTTY: true, write(data: string) { lines.push(data); return true; } };
  printError(new Error("Usage: archil sandbox [options] [command]\n\nCommands:\n  list"), stream);
  assert.equal(lines.join(""), "Usage: archil sandbox [options] [command]\n\nCommands:\n  list\n");
});

test("a rejected key's hint names the source the key actually came from", () => {
  const lines: string[] = [];
  const stream = { isTTY: false, write(data: string) { lines.push(data); return true; } };
  const rejected = new ArchilApiError("API request failed with status 401", 401);
  printError(rejected, stream, "archil", { credentials: { source: "env", region: "aws-us-east-1" } });
  assert.match(lines.join(""), /ARCHIL_API_KEY was used; it takes precedence over saved profiles/);
  lines.length = 0;
  printError(rejected, stream, "archil", { credentials: { source: "profile", profile: "acme", region: "aws-us-west-2" } });
  assert.match(lines.join(""), /The key saved in profile acme for aws-us-west-2 was used/);
  assert.doesNotMatch(lines.join(""), /ARCHIL_API_KEY was used/);
  lines.length = 0;
  printError(rejected, stream, "archil", { credentials: { source: "flag", region: "aws-us-east-1" } });
  assert.match(lines.join(""), /--api-key was used/);
  lines.length = 0;
  printError(rejected, stream, "archil", { credentials: null });
  assert.match(lines.join(""), /Sign in with archil login/);
});

test("login warns when environment variables will override the profile it saved", async () => {
  vi.stubEnv("ARCHIL_CONSOLE_URL", "https://console.example.com");
  vi.stubEnv("ARCHIL_API_KEY", "key-old");
  vi.stubEnv("ARCHIL_REGION", "aws-us-west-2");
  let output = "";
  const stderr = { isTTY: false, write(data: string) { output += data; return true; } };
  const program = createArchilProgram({
    version: "test",
    createClient: () => { throw new Error("unused"); },
    stderr,
    validateCredential: async ({ region }) => region!,
    openUrl: (url) => {
      const params = new URL(url).searchParams;
      void fetch(`http://127.0.0.1:${params.get("port")}/callback`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://console.example.com" },
        body: new URLSearchParams({ state: params.get("state")!, apiKey: "key-new", region: "aws-us-east-1", account: "Acme" }),
      });
    },
  });
  await program.parseAsync(["node", "archil", "login"]);
  assert.match(output, /Signed in to Acme/);
  assert.match(output, /ARCHIL_API_KEY, ARCHIL_REGION are set in your environment and take precedence over this profile/);
  assert.match(output, /unset ARCHIL_API_KEY ARCHIL_REGION/);
});

async function loginWith(argv: string[]): Promise<string> {
  vi.stubEnv("ARCHIL_CONSOLE_URL", "https://console.example.com");
  for (const variable of ["ARCHIL_API_KEY", "ARCHIL_REGION", "ARCHIL_BASE_URL"]) vi.stubEnv(variable, undefined);
  let output = "";
  const stderr = { isTTY: false, write(data: string) { output += data; return true; } };
  const program = createArchilProgram({
    version: "test",
    createClient: () => { throw new Error("unused"); },
    stderr,
    validateCredential: async ({ region }) => region!,
    openUrl: (url) => {
      const params = new URL(url).searchParams;
      void fetch(`http://127.0.0.1:${params.get("port")}/callback`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://console.example.com" },
        body: new URLSearchParams({ state: params.get("state")!, apiKey: "key-new", region: "aws-us-east-1", account: "Acme" }),
      });
    },
  });
  await program.parseAsync(["node", "archil", ...argv, "login"]);
  return output;
}

test("ARCHIL_PROFILE that picked the login's own profile isn't reported as an override", async () => {
  vi.stubEnv("ARCHIL_PROFILE", "work");
  const output = await loginWith([]);
  assert.match(output, /as profile work/);
  assert.doesNotMatch(output, /precedence/);
});

test("ARCHIL_PROFILE naming a different profile than --profile is reported", async () => {
  vi.stubEnv("ARCHIL_PROFILE", "work");
  const output = await loginWith(["--profile", "personal"]);
  assert.match(output, /as profile personal/);
  assert.match(output, /ARCHIL_PROFILE is set in your environment and takes precedence over this profile/);
});
