import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { Sandbox } from "../src/sandbox.js";
import { createSandboxProgram, type SandboxService } from "../src/cli/sandbox-command.js";
import { DESKTOP_IMAGE, DESKTOP_MAX_TTL_SECONDS } from "../src/cli/sandbox-desktop.js";
import { addRequestHeader, openPortTunnel, type PortTunnelOptions } from "../src/cli/port-tunnel.js";

let configDirectory: string;

beforeEach(async () => {
  configDirectory = await mkdtemp(join(tmpdir(), "sandbox-desktop-test-"));
  vi.stubEnv("ARCHIL_DISK_CONFIG_DIR", configDirectory);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(configDirectory, { recursive: true, force: true });
});

const TOKEN = "ab".repeat(32);

function desktopSandbox(overrides: Partial<Record<string, unknown>> = {}): Sandbox {
  const sandbox = {
    id: "0198aabb-1234-7abc-8def-0123456789ab",
    name: "desk",
    status: "running",
    vcpuCount: 2,
    memSizeMiB: 4096,
    baseImage: DESKTOP_IMAGE,
    maxTtlSeconds: DESKTOP_MAX_TTL_SECONDS,
    idleTtlSeconds: 0,
    onTimeout: "pause",
    maxConcurrentExecs: 4,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    lastActiveAt: new Date("2026-01-02T00:00:00Z"),
    exec: vi.fn(async (command: string) => command === "desktopctl up"
      ? { status: "completed", exitCode: 0, stdout: `{"port": 6080, "token": "${TOKEN}"}\n`, stderr: "" }
      : { status: "completed", exitCode: 0, stdout: "", stderr: "" }),
    resume: vi.fn(async function(this: { status: string }) { this.status = "running"; }),
    start: vi.fn(async function(this: { status: string }) { this.status = "running"; }),
    exposePort: vi.fn(async () => "6080-route.example.archil.app"),
    unexposePort: vi.fn(async () => undefined),
    createPortToken: vi.fn(async () => ({ id: "tok-1", port: 6080, createdAt: new Date(), hostname: "6080-route.example.archil.app", token: "secret" })),
    deletePortToken: vi.fn(async () => undefined),
    ...overrides,
  };
  return sandbox as unknown as Sandbox;
}

function harness(sandbox: Sandbox, options: { tty?: boolean } = {}) {
  const stdout = { values: [] as string[], write(data: string) { this.values.push(data); return true; } };
  const stderr = { isTTY: options.tty ?? false, values: [] as string[], write(data: string) { this.values.push(data); return true; } };
  const signals = new EventEmitter();
  const opened: string[] = [];
  const tunnels: PortTunnelOptions[] = [];
  const closeTunnel = vi.fn(async () => undefined);
  const service: SandboxService = {
    list: vi.fn(async () => [sandbox]),
    get: vi.fn(async () => sandbox),
    create: vi.fn(async () => sandbox),
  };
  const program = createSandboxProgram({
    version: "test",
    createClient: () => ({ sandboxes: service }),
    stdout,
    stderr,
    signals: signals as NodeJS.Process,
    openUrl: (url) => opened.push(url),
    openTunnel: async (options) => {
      tunnels.push(options);
      return { port: options.localPort || 49_152, close: closeTunnel };
    },
  });
  const run = (...args: string[]) => program.parseAsync(["node", "sandbox", "--api-key", "key-test", "--region", "test", ...args]);
  return { stdout, stderr, signals, opened, tunnels, closeTunnel, service, run };
}

test("create --desktop picks the desktop image and timeouts, then starts the desktop", async () => {
  const sandbox = desktopSandbox();
  const cli = harness(sandbox, { tty: true });
  await cli.run("create", "desk", "--desktop");
  const request = (cli.service.create as ReturnType<typeof vi.fn>).mock.calls[0]![0];
  assert.equal(request.baseImage, DESKTOP_IMAGE);
  assert.equal(request.idleTtlSeconds, 0);
  assert.equal(request.maxTtlSeconds, DESKTOP_MAX_TTL_SECONDS);
  assert.deepEqual((sandbox.exec as ReturnType<typeof vi.fn>).mock.calls.map(([command]) => command), ["desktopctl up"]);
  assert.match(cli.stderr.values.join(""), /sandbox desktop desk/);

  const explicit = harness(desktopSandbox());
  await explicit.run("create", "desk", "--desktop", "--base-image", "ghcr.io/acme/desk:1", "--idle-ttl-seconds", "600");
  const custom = (explicit.service.create as ReturnType<typeof vi.fn>).mock.calls[0]![0];
  assert.equal(custom.baseImage, "ghcr.io/acme/desk:1");
  assert.equal(custom.idleTtlSeconds, 600);

  const plain = harness(desktopSandbox());
  await plain.run("create", "plain");
  const plainRequest = (plain.service.create as ReturnType<typeof vi.fn>).mock.calls[0]![0];
  assert.equal(plainRequest.baseImage, "ubuntu:26.04");
  assert.equal(plainRequest.idleTtlSeconds, undefined);

  await assert.rejects(harness(desktopSandbox()).run("create", "desk", "--desktop", "--no-wait"), /remove --no-wait/);
});

test("desktop explains when the sandbox has no desktop installed", async () => {
  const sandbox = desktopSandbox({
    exec: vi.fn(async () => ({ status: "failed", exitCode: 127, stdout: "", stderr: "desktopctl: not found" })),
  });
  await assert.rejects(harness(sandbox).run("desktop", "desk", "--share"), /doesn't have the Archil desktop installed/);
});

test("desktop --share publishes a link and --unshare revokes it", async () => {
  const sandbox = desktopSandbox();
  const shared = harness(sandbox);
  await shared.run("desktop", "desk", "--share");
  const url = new URL(shared.stdout.values.join("").trim());
  assert.equal(url.origin, "https://6080-route.example.archil.app");
  assert.equal(url.searchParams.get("path"), `websockify?token=${TOKEN}`);
  assert.deepEqual((sandbox.exposePort as ReturnType<typeof vi.fn>).mock.calls, [[6080]]);

  const unshared = harness(sandbox);
  await unshared.run("desktop", "desk", "--unshare", "-o", "json");
  assert.deepEqual((sandbox.unexposePort as ReturnType<typeof vi.fn>).mock.calls, [[6080]]);
  assert.ok((sandbox.exec as ReturnType<typeof vi.fn>).mock.calls.some(([command]) => command === "desktopctl revoke"));
  assert.deepEqual(JSON.parse(unshared.stdout.values.join("")), { id: sandbox.id, name: "desk", url: null, shared: false });

  await assert.rejects(harness(sandbox).run("desktop", "desk", "--share", "--unshare"), /either --share or --unshare/);
});

test("desktop wakes a paused sandbox, tunnels privately, and cleans up on Ctrl-C", async () => {
  const sandbox = desktopSandbox({ status: "paused" });
  const cli = harness(sandbox);
  const running = cli.run("desktop", "desk");
  await vi.waitFor(() => assert.equal(cli.opened.length, 1));
  assert.equal((sandbox.resume as ReturnType<typeof vi.fn>).mock.calls.length, 1);
  assert.deepEqual(
    cli.tunnels.map(({ hostname, portToken, localPort }) => ({ hostname, portToken, localPort })),
    [{ hostname: "6080-route.example.archil.app", portToken: "secret", localPort: 6080 }],
  );
  assert.match(cli.opened[0]!, /^http:\/\/localhost:6080\/vnc\.html\?/);
  assert.equal(cli.stdout.values.join("").trim(), cli.opened[0]);
  assert.equal((sandbox.exposePort as ReturnType<typeof vi.fn>).mock.calls.length, 0);

  cli.signals.emit("SIGINT");
  await running;
  assert.equal(cli.closeTunnel.mock.calls.length, 1);
  assert.deepEqual((sandbox.deletePortToken as ReturnType<typeof vi.fn>).mock.calls, [["tok-1"]]);
  assert.equal(cli.signals.listenerCount("SIGINT"), 0);
});

test("desktop falls back to a free port only when the default one is taken", async () => {
  const sandbox = desktopSandbox();
  const stdout = { values: [] as string[], write(data: string) { this.values.push(data); return true; } };
  const signals = new EventEmitter();
  const ports: number[] = [];
  const program = createSandboxProgram({
    version: "test",
    createClient: () => ({ sandboxes: { list: async () => [sandbox], get: async () => sandbox, create: async () => sandbox } }),
    stdout,
    stderr: { write: () => true },
    signals: signals as NodeJS.Process,
    openUrl: () => {},
    openTunnel: async ({ localPort }) => {
      ports.push(localPort);
      if (localPort === 6080) throw Object.assign(new Error("in use"), { code: "EADDRINUSE" });
      return { port: 51_000, close: async () => {} };
    },
  });
  const running = program.parseAsync(["node", "sandbox", "--api-key", "k", "--region", "r", "desktop", "desk", "--no-open"]);
  await vi.waitFor(() => assert.match(stdout.values.join(""), /localhost:51000/));
  signals.emit("SIGTERM");
  await running;
  assert.deepEqual(ports, [6080, 0]);

  const pinned = createSandboxProgram({
    version: "test",
    createClient: () => ({ sandboxes: { list: async () => [sandbox], get: async () => sandbox, create: async () => sandbox } }),
    stdout,
    stderr: { write: () => true },
    signals: signals as NodeJS.Process,
    openTunnel: async () => { throw Object.assign(new Error("in use"), { code: "EADDRINUSE" }); },
  });
  await assert.rejects(pinned.parseAsync(["node", "sandbox", "--api-key", "k", "--region", "r", "desktop", "desk", "--port", "7000"]), /in use/);
  assert.ok((sandbox.deletePortToken as ReturnType<typeof vi.fn>).mock.calls.length >= 1);
});

test("addRequestHeader inserts after the request line only", () => {
  const head = Buffer.from("GET /websockify HTTP/1.1\r\nHost: localhost\r\n\r\nrest");
  assert.equal(
    addRequestHeader(head, "X-Archil-Token: t").toString(),
    "GET /websockify HTTP/1.1\r\nX-Archil-Token: t\r\nHost: localhost\r\n\r\nrest",
  );
});

test("the tunnel adds the port token to the first request and relays everything else unchanged", async () => {
  const received: Buffer[] = [];
  const upstreamServer = createServer((socket) => {
    socket.on("data", (chunk) => {
      received.push(Buffer.from(chunk));
      if (Buffer.concat(received).includes("second")) socket.end("pong");
    });
  });
  await new Promise<void>((resolve) => upstreamServer.listen(0, "127.0.0.1", resolve));
  const upstreamPort = (upstreamServer.address() as { port: number }).port;

  const tunnel = await openPortTunnel({
    hostname: "ignored.example",
    portToken: "secret",
    localPort: 0,
    connectUpstream: () => connect(upstreamPort, "127.0.0.1"),
  });
  try {
    const client: Socket = connect(tunnel.port, "127.0.0.1");
    const reply = new Promise<string>((resolve) => {
      let data = "";
      client.on("data", (chunk) => { data += chunk.toString(); });
      client.on("close", () => resolve(data));
    });
    client.write("GET /a HTTP/1.1\r\nHost: x\r\n");
    client.write("\r\n");
    await vi.waitFor(() => assert.ok(Buffer.concat(received).includes("\r\n\r\n")));
    client.write("second request bytes");
    assert.equal(await reply, "pong");
    assert.equal(
      Buffer.concat(received).toString(),
      "GET /a HTTP/1.1\r\nX-Archil-Token: secret\r\nHost: x\r\n\r\nsecond request bytes",
    );
  } finally {
    await tunnel.close();
    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
  }
});
