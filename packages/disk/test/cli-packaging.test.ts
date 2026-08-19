import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { beforeAll, test } from "vitest";

const packageRoot = resolve(import.meta.dirname, "..");
const cli = join(packageRoot, "dist", "cli.mjs");

beforeAll(() => {
  if (!existsSync(cli)) {
    const built = spawnSync("pnpm", ["build"], { cwd: packageRoot, encoding: "utf8" });
    assert.equal(built.status, 0, built.stderr);
  }
});

function run(args: string[], env: NodeJS.ProcessEnv = {}, input?: string) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: packageRoot,
    env: { ...process.env, ...env },
    input,
    encoding: "utf8",
  });
}

test("built CLI exposes sandbox/profile help and rejects non-TTY sandbox use", () => {
  const help = run(["--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /sandboxes/);
  assert.match(help.stdout, /auth/);
  assert.match(help.stdout, /profile/);
  const rejected = run(["sandboxes", "--api-key", "fake", "--region", "aws-us-east-1"]);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /requires an interactive terminal/);
});

test("built CLI profile workflow persists metadata without exposing the key", async () => {
  const directory = await mkdtemp(join(packageRoot, ".cli-smoke-"));
  try {
    const env = { ARCHIL_DISK_CONFIG_DIR: directory };
    const login = run(["auth", "login", "--profile", "smoke", "--region", "aws-us-east-1"], env, "key-super-secret\n");
    assert.equal(login.status, 0, login.stderr);
    const listed = run(["profile", "list"], env);
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /smoke\s+aws-us-east-1\s+default/);
    assert.equal(listed.stdout.includes("super-secret"), false);
    const used = run(["profile", "use", "smoke"], env);
    assert.equal(used.status, 0, used.stderr);
    assert.equal((await readFile(join(directory, "config.json"), "utf8")).includes("super-secret"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
