import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import {
  createArchilProgram,
  findNativeClient,
  firstCommand,
  forwardToNativeClient,
  isNativeCommand,
} from "../src/cli/archil-command.js";
import { rewriteDiskExecSugar } from "../src/cli/disk-command.js";
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
  const native = await executable(join(directory, "native", "archil"), `#!/bin/sh\n[ "$ARCHIL_CLI_FORWARDED" = 1 ] || exit 9\n[ "$1 $2" = "mount dsk-1" ] && exit 3\nexit 1\n`);
  const env = { PATH: join(directory, "native") };
  assert.equal(await forwardToNativeClient(["mount", "dsk-1"], env, join(directory, "self.mjs")), 3);
  await assert.rejects(forwardToNativeClient(["mount"], { PATH: "" }, join(directory, "self.mjs")), /curl https:\/\/archil\.com\/install \| sh/);
  await assert.rejects(forwardToNativeClient(["mount"], { ...env, ARCHIL_CLI_FORWARDED: "1" }, native), /forwarded back/);
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
