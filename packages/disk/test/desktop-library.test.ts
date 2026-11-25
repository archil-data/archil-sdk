import assert from "node:assert/strict";
import { connect, createServer } from "node:net";
import { test, vi } from "vitest";
import type { Sandbox } from "../src/sandbox.js";
import { DesktopNotInstalledError, SandboxDesktop, desktopViewerPath } from "../src/sandbox-desktop.js";
import { forwardPort, openDesktopTunnel, type PortTunnelOptions } from "../src/tunnel.js";

const TOKEN = "cd".repeat(32);

function fakeSandbox(handler: (command: string, env?: Record<string, string>) => { exitCode: number; stdout?: string; stderr?: string }) {
  const keepalive = { kill: vi.fn(async () => undefined), disconnect: vi.fn(async () => undefined) };
  let tokens = 0;
  const sandbox = {
    name: "desk",
    exec: vi.fn(async (command: string, options?: { env?: Record<string, string> }) => {
      const result = handler(command, options?.env);
      return { status: result.exitCode === 0 ? "completed" : "failed", stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.exitCode };
    }),
    exposePort: vi.fn(async () => "6080-route.example.archil.app"),
    unexposePort: vi.fn(async () => undefined),
    createPortToken: vi.fn(async (port: number) => ({ id: `tok-${++tokens}`, port, createdAt: new Date(), hostname: `${port}-route.example.archil.app`, token: `secret-${tokens}` })),
    deletePortToken: vi.fn(async () => undefined),
    run: vi.fn(async (_command: string, _options?: unknown) => keepalive),
    processes: { disconnect: vi.fn(async () => undefined) },
  };
  const typed = sandbox as unknown as Sandbox;
  Object.assign(sandbox, { desktop: new SandboxDesktop(typed) });
  return { sandbox: typed, raw: sandbox, keepalive };
}

const desktopUp = (command: string) => command === "desktopctl up"
  ? { exitCode: 0, stdout: `{"port": 6080, "token": "${TOKEN}"}\n` }
  : { exitCode: 0, stdout: "" };

test("start, share, and unshare drive desktopctl and the public port", async () => {
  const { sandbox, raw } = fakeSandbox(desktopUp);
  assert.deepEqual(await sandbox.desktop.start(), { token: TOKEN });
  const link = new URL(await sandbox.desktop.share());
  assert.equal(link.origin, "https://6080-route.example.archil.app");
  assert.equal(`${link.pathname}${link.search}`, desktopViewerPath(TOKEN));
  await sandbox.desktop.unshare();
  assert.deepEqual(raw.unexposePort.mock.calls, [[6080]]);
  assert.ok(raw.exec.mock.calls.some(([command]) => command === "desktopctl revoke"));
});

test("computer-use helpers send safe xdotool and scrot commands", async () => {
  const commands: Array<[string, Record<string, string> | undefined]> = [];
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const { sandbox } = fakeSandbox((command, env) => {
    commands.push([command, env]);
    if (command.includes("scrot")) return { exitCode: 0, stdout: `${Buffer.from(png).toString("base64")}\n` };
    if (command.includes("getdisplaygeometry")) return { exitCode: 0, stdout: "1920 1080\n" };
    return { exitCode: 0 };
  });
  assert.deepEqual(await sandbox.desktop.screenshot(), png);
  assert.deepEqual(await sandbox.desktop.size(), { width: 1920, height: 1080 });
  await sandbox.desktop.click(10.4, 20, { button: "right", double: true });
  await sandbox.desktop.scroll("down", 5);
  await sandbox.desktop.type(`it's "quoted" $HOME`);
  await sandbox.desktop.key("ctrl+l");
  await sandbox.desktop.launch(["firefox", "https://example.com/?a=1&b='2'"]);
  assert.match(commands[2]![0], /xdotool mousemove 10 20 click --repeat 2 3$/);
  assert.match(commands[3]![0], /xdotool click --repeat 5 5$/);
  assert.deepEqual(commands[4]![1], { ARCHIL_DESKTOP_TEXT: `it's "quoted" $HOME` }, "text travels in the environment, never the command line");
  assert.deepEqual(commands[5]![1], { ARCHIL_DESKTOP_KEYS: "ctrl+l" });
  assert.equal(commands[6]![0], `desktopctl launch 'firefox' 'https://example.com/?a=1&b='\\''2'\\'''`);

  await assert.rejects(sandbox.desktop.key("ctrl+l; rm -rf /"), /Invalid key/);
  await assert.rejects(sandbox.desktop.click(-1, 5), /Invalid screen coordinate/);
  await assert.rejects(sandbox.desktop.launch([]), /needs a program/);
});

test("a sandbox without the desktop says so", async () => {
  const { sandbox } = fakeSandbox(() => ({ exitCode: 127, stderr: "desktopctl: not found" }));
  await assert.rejects(sandbox.desktop.start(), DesktopNotInstalledError);
});

test("forwardPort relays with the token, keeps the sandbox awake, and cleans up", async () => {
  const received: Buffer[] = [];
  const upstream = createServer((socket) => socket.on("data", (chunk) => { received.push(Buffer.from(chunk)); socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"); }));
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = (upstream.address() as { port: number }).port;
  const { sandbox, raw, keepalive } = fakeSandbox(desktopUp);
  try {
    const forwarded = await forwardPort(sandbox, 8080, {
      localPort: 0,
      openTunnel: async (options: PortTunnelOptions) => {
        const { openPortTunnel } = await import("../src/tunnel.js");
        return openPortTunnel({ ...options, connectUpstream: () => connect(upstreamPort, "127.0.0.1") });
      },
    });
    const response = await fetch(`${forwarded.url}/health`);
    assert.equal(await response.text(), "ok");
    assert.match(Buffer.concat(received).toString(), /^GET \/health HTTP\/1\.1\r\nX-Archil-Token: secret-1\r\n/);
    assert.equal(raw.run.mock.calls[0]?.[0], "exec tail -f /dev/null");
    await forwarded.close();
    await forwarded.close();
    assert.deepEqual(raw.deletePortToken.mock.calls, [["tok-1"]], "revoked once, even when closed twice");
    assert.equal(keepalive.kill.mock.calls.length, 1);
  } finally {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("forwardPort falls back to a free port only when it picked the port itself", async () => {
  for (const code of ["EADDRINUSE", "EACCES"]) {
    const { sandbox } = fakeSandbox(desktopUp);
    const ports: number[] = [];
    const forwarded = await forwardPort(sandbox, 80, {
      keepAwake: false,
      openTunnel: async ({ localPort }) => {
        ports.push(localPort);
        if (localPort === 80) throw Object.assign(new Error(code), { code });
        return { port: 50_123, setPortToken: () => {}, close: async () => {} };
      },
    });
    assert.deepEqual(ports, [80, 0]);
    assert.equal(forwarded.url, "http://localhost:50123");
  }
  const { sandbox, raw } = fakeSandbox(desktopUp);
  await assert.rejects(forwardPort(sandbox, 80, {
    localPort: 80,
    openTunnel: async () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); },
  }), /EACCES/);
  assert.deepEqual(raw.deletePortToken.mock.calls, [["tok-1"]], "the token is revoked when the tunnel can't open");
});

test("openDesktopTunnel starts the desktop and returns a viewer URL", async () => {
  const { sandbox } = fakeSandbox(desktopUp);
  const tunnel = await openDesktopTunnel(sandbox, {
    keepAwake: false,
    openTunnel: async () => ({ port: 6080, setPortToken: () => {}, close: async () => {} }),
  });
  assert.equal(tunnel.viewerUrl, `http://localhost:6080${desktopViewerPath(TOKEN)}`);
  await tunnel.close();
});
