import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { beforeAll, test } from "vitest";

const packageRoot = resolve(import.meta.dirname, "..");
const diskCli = join(packageRoot, "dist", "cli.mjs");
const sandboxCli = join(packageRoot, "dist", "sandbox-cli.mjs");

beforeAll(() => {
  if (!existsSync(diskCli) || !existsSync(sandboxCli)) {
    const built = spawnSync("pnpm", ["build"], { cwd: packageRoot, encoding: "utf8" });
    assert.equal(built.status, 0, built.stderr);
  }
});

function run(cli: string, args: string[], env: NodeJS.ProcessEnv = {}, input?: string) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: packageRoot,
    env: { ...process.env, ...env },
    input,
    encoding: "utf8",
  });
}

function runAsync(cli: string, args: string[], env: NodeJS.ProcessEnv, input?: string) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: packageRoot,
      env: { ...process.env, ...env },
      stdio: "pipe",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

test("built package exposes disk and sandbox help", () => {
  const diskHelp = run(diskCli, ["--help"]);
  assert.equal(diskHelp.status, 0, diskHelp.stderr);
  assert.doesNotMatch(diskHelp.stdout, /^\s+auth\b/m);
  assert.match(diskHelp.stdout, /profile/);

  const sandboxHelp = run(sandboxCli, ["--help"]);
  assert.equal(sandboxHelp.status, 0, sandboxHelp.stderr);
  for (const command of ["list", "get", "create", "start", "pause", "resume", "stop", "fork", "delete", "run", "shell", "profile"]) {
    assert.match(sandboxHelp.stdout, new RegExp(`\\b${command}\\b`));
  }
});

test("disk and sandbox profile commands share one protected profile store and support JSON", async () => {
  const directory = await mkdtemp(join(packageRoot, ".cli-smoke-"));
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ success: true, data: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const env = { ARCHIL_DISK_CONFIG_DIR: directory };
    const diskCreate = await runAsync(diskCli, ["profile", "create", "--profile", "disk-profile", "--region", "aws-us-east-1", "--base-url", baseUrl, "--output", "json"], env, "key-disk-secret\n");
    assert.equal(diskCreate.status, 0, diskCreate.stderr);
    assert.deepEqual(JSON.parse(diskCreate.stdout), {
      name: "disk-profile", region: "aws-us-east-1", baseUrl, current: true,
    });
    const sandboxList = run(sandboxCli, ["profile", "list", "--output", "json"], env);
    assert.equal(sandboxList.status, 0, sandboxList.stderr);
    assert.deepEqual(JSON.parse(sandboxList.stdout), [{
      name: "disk-profile", region: "aws-us-east-1", baseUrl, current: true,
    }]);
    assert.equal(sandboxList.stdout.includes("disk-secret"), false);

    const sandboxCreate = await runAsync(sandboxCli, ["profile", "create", "--profile", "sandbox-profile", "--region", "aws-us-west-2", "--base-url", baseUrl], env, "key-sandbox-secret\n");
    assert.equal(sandboxCreate.status, 0, sandboxCreate.stderr);
    const diskList = run(diskCli, ["profile", "list"], env);
    assert.equal(diskList.status, 0, diskList.stderr);
    assert.match(diskList.stdout, /sandbox-profile\s+│ aws-us-west-2/);
    assert.equal(diskList.stdout.includes("sandbox-secret"), false);

    const config = await readFile(join(directory, "config.json"), "utf8");
    assert.equal(config.includes("disk-secret"), false);
    assert.equal(config.includes("sandbox-secret"), false);
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
