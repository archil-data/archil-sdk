import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "vitest";
import { createMockDisk } from "@archildata/mock";
import { Archil, type ExecMountSpec, type ExecOptions, type ExecResult } from "disk";
import { archilBackend } from "../src/sandbox.js";

const runtimeContext = { appRoot: "/app" };

test("prewarm writes seeds as objects and uses scoped control checkouts", async () => {
  const calls: ExecOptions[] = [];
  const disk = createMockDisk({ id: "dsk-1" });
  const client = createClient(calls);
  client.disks.get = async (id) => {
    assert.equal(id, "dsk-1");
    return disk;
  };
  const backend = archilBackend({
    client,
    disk: "dsk-1",
    rootPrefix: ".eve/test",
  });

  await backend.prewarm({
    templateKey: "template-a",
    runtimeContext,
    seedFiles: [
      { path: "/workspace/a.txt", content: "a" },
      { path: "/workspace/nested/b.txt", content: Buffer.from("b") },
    ],
  });

  const setupMount = mountSpec(calls[0], "store");
  assert.equal(setupMount.queueMs, 5000);
  assert.equal(setupMount.checkoutPaths, undefined);
  assert.match(calls[0].command, /mkdir -p/);

  const mount = mountSpec(calls[1], "store");
  assert.equal(mount.disk, "dsk-1");
  assert.equal(mount.queueMs, 5000);
  assert.deepEqual(mount.checkoutPaths, [".eve/test/templates"]);
  assert.match(calls[1].command, /templates\/\.tmp-/);

  assert.deepEqual(
    disk.calls.putObject.map((call) => call.key).sort(),
    [
      `${templateTempPath("template-a")}/a.txt`,
      `${templateTempPath("template-a")}/nested/b.txt`,
    ],
  );
  assert.equal(disk.getText(`${templateTempPath("template-a")}/a.txt`), "a");
  assert.equal(Buffer.from(disk.getBytes(`${templateTempPath("template-a")}/nested/b.txt`) ?? []).toString(), "b");
  assert.doesNotMatch(calls.map((call) => call.command).join("\n"), /ARCHIL_EVE_SEED/);

  const publishMount = mountSpec(calls[2], "store");
  assert.equal(publishMount.disk, "dsk-1");
  assert.equal(publishMount.queueMs, 5000);
  assert.deepEqual(publishMount.checkoutPaths, [".eve/test/templates"]);
  assert.match(calls[2].command, /mv/);
});

test("control directory setup failure is retried", async () => {
  const calls: ExecOptions[] = [];
  let setupAttempts = 0;
  const backend = archilBackend({
    client: createClient(calls, (opts) => {
      if (isControlParentSetupCommand(opts.command)) {
        setupAttempts += 1;
        if (setupAttempts === 1) return execFailure();
      }
      return execResult();
    }),
    disk: "dsk-1",
    rootPrefix: ".eve/test",
  });

  await assert.rejects(() => backend.prewarm({
    templateKey: "template-a",
    runtimeContext,
    seedFiles: [],
  }));

  await backend.prewarm({
    templateKey: "template-a",
    runtimeContext,
    seedFiles: [],
  });

  assert.equal(setupAttempts, 2);
  assert.equal(calls.filter((call) => isControlParentSetupCommand(call.command)).length, 2);
});

test("create write execs use the configured queue and scoped session checkouts", async () => {
  const calls: ExecOptions[] = [];
  const backend = archilBackend({
    client: createClient(calls),
    disk: "dsk-1",
    rootPrefix: ".eve/test",
    queueMs: 250,
  });

  await backend.create({
    templateKey: "template-a",
    sessionKey: "session-a",
    runtimeContext,
  });

  const mount = mountSpec(calls[1], "store");
  assert.equal(mount.queueMs, 250);
  assert.deepEqual(mount.checkoutPaths, [".eve/test/sessions"]);
  assert.match(calls[1].command, /sessions\/\.tmp-/);
});

test("session file operations use objects and shell operations use scoped mounts", async () => {
  const calls: ExecOptions[] = [];
  const disk = createMockDisk({
    id: "dsk-1",
    files: {
      [`${sessionPath("session-a")}/reports/out.txt`]: "hello",
    },
  });
  const client = createClient(calls);
  let diskLookups = 0;
  client.disks.get = async (id) => {
    diskLookups += 1;
    assert.equal(id, "dsk-1");
    return disk;
  };
  const backend = archilBackend({
    client,
    disk: "dsk-1",
    rootPrefix: ".eve/test",
  });
  const handle = await backend.create({
    templateKey: null,
    sessionKey: "session-a",
    runtimeContext,
  });
  calls.length = 0;

  assert.equal(await handle.session.readTextFile({ path: "reports/out.txt" }), "hello");
  assert.deepEqual(disk.calls.getObject, [`${sessionPath("session-a")}/reports/out.txt`]);
  assert.equal(calls.length, 0);

  assert.equal(await handle.session.readTextFile({ path: "reports/missing.txt" }), null);
  assert.deepEqual(disk.calls.getObject, [
    `${sessionPath("session-a")}/reports/out.txt`,
    `${sessionPath("session-a")}/reports/missing.txt`,
  ]);
  assert.equal(calls.length, 0);

  assert.equal(handle.session.resolvePath("/reports/out.txt"), "/workspace/reports/out.txt");
  assert.equal(handle.session.resolvePath("/workspace/reports/out.txt"), "/workspace/reports/out.txt");

  await handle.session.writeTextFile({ path: "/reports/out.txt", content: "updated" });
  assert.deepEqual(disk.calls.putObject, [
    { key: `${sessionPath("session-a")}/reports/out.txt`, contentType: undefined },
  ]);
  assert.equal(disk.getText(`${sessionPath("session-a")}/reports/out.txt`), "updated");
  assert.equal(diskLookups, 1);
  assert.equal(calls.length, 0);

  calls.length = 0;
  await handle.session.removePath({ path: "reports/out.txt" });
  let mount = mountSpec(calls[0], "workspace");
  assert.equal(mount.queueMs, 5000);
  assert.deepEqual(mount.checkoutPaths, ["reports"]);

  calls.length = 0;
  await handle.session.run({ command: "touch arbitrary-path" });
  mount = mountSpec(calls[0], "workspace");
  assert.equal(mount.queueMs, 5000);
  assert.equal(mount.checkoutPaths, undefined);
});

function createClient(
  calls: ExecOptions[],
  exec: (opts: ExecOptions) => ExecResult | Promise<ExecResult> = () => execResult(),
): Archil {
  const client = new Archil({
    apiKey: "key-test",
    region: "aws-us-east-1",
    baseUrl: "http://control.test",
    s3BaseUrl: "http://s3.test",
  });
  client.exec = async (opts) => {
    calls.push(opts);
    return exec(opts);
  };
  return client;
}

function execResult(stdout = ""): ExecResult {
  return {
    exitCode: 0,
    stdout,
    stderr: "",
    timing: { totalMs: 0, queueMs: 0, executeMs: 0 },
  };
}

function execFailure(): ExecResult {
  return {
    exitCode: 1,
    stdout: "",
    stderr: "setup failed",
    timing: { totalMs: 0, queueMs: 0, executeMs: 0 },
  };
}

function isControlParentSetupCommand(command: string): boolean {
  return command.includes(".eve/test/templates") && command.includes(".eve/test/sessions");
}

function mountSpec(opts: ExecOptions, mountName: string): ExecMountSpec {
  const mount = opts.disks[mountName];
  assert.ok(isExecMountSpec(mount));
  return mount;
}

function isExecMountSpec(value: unknown): value is ExecMountSpec {
  return typeof value === "object" && value !== null && "disk" in value;
}

function sessionPath(sessionKey: string): string {
  return `.eve/test/sessions/${stablePathSegment(sessionKey)}`;
}

function templateTempPath(templateKey: string): string {
  return `.eve/test/templates/.tmp-${stablePathSegment(templateKey)}`;
}

function stablePathSegment(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
