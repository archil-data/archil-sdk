// Commands that reach into a sandbox from this machine: `desktop`, `forward`,
// `ssh`, `ssh-proxy`, and `ssh-config`.

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Command } from "./command.js";
import type { Sandbox } from "../sandbox.js";
import type { OutputFormat } from "./sandbox-output.js";
import { optionalInteger } from "./sandbox-options.js";
import {
  DESKTOP_PORT,
  shareDesktop,
  startDesktop,
  unshareDesktop,
  viewerPath,
} from "./sandbox-desktop.js";
import type { PortTunnel, PortTunnelActivity, PortTunnelOptions } from "./port-tunnel.js";
import {
  ensureSshKey,
  prepareSandboxSsh,
  relaySshd,
  rememberHostKey,
  sshConfigBlock,
  sshKeyPath,
  sshKnownHostsPath,
  sshOptions,
  sshTarget,
  SSH_HOST_SUFFIX,
} from "./sandbox-ssh.js";
import { formatDuration, type Ui } from "./ui.js";
import type { OutputStream } from "./write-output.js";

const TUNNEL_TOKEN_TTL = "12h";
const TUNNEL_TOKEN_RENEW_MS = 11 * 60 * 60 * 1000;
/** The keepalive ends on its own after this, in case the CLI dies without cleaning up. */
const KEEPALIVE_MAX_SECONDS = 36 * 60 * 60;
const SSH_INCLUDE_FILE = "archil_config";
const SSH_INCLUDE_LINE = `Include ~/.ssh/${SSH_INCLUDE_FILE}`;
/** The block an earlier version of `ssh-config --install` appended. */
const LEGACY_BLOCK = /# >>> archil sandboxes >>>[\s\S]*?# <<< archil sandboxes <<<\n?/;

/** `config` with the archil Include as its first line, exactly once, and no legacy appended block. */
export function withArchilInclude(config: string): string {
  const rest = config
    .replace(LEGACY_BLOCK, "")
    .split("\n")
    .filter((line) => line.trim() !== SSH_INCLUDE_LINE)
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n{2,}$/, "\n");
  return `${SSH_INCLUDE_LINE}\n${rest ? `\n${rest}` : ""}`;
}

export interface AccessContext {
  program: Command;
  ui: Ui;
  stdout: OutputStream & { isTTY?: boolean };
  stderr: OutputStream & { isTTY?: boolean };
  stdin: NodeJS.ReadStream;
  signals: NodeJS.Process;
  now: () => number;
  output: (value: string) => void;
  formatOption: (command: Command) => Command;
  resolve: (target: string) => Promise<Sandbox>;
  credentials: () => { apiKey: string; region: string; baseUrl?: string; profile?: string };
  openUrl: (url: string) => void;
  openTunnel: (options: PortTunnelOptions) => Promise<PortTunnel>;
  /** argv prefix that runs this CLI's sandbox commands, e.g. [node, archil.mjs, "sandbox"]. */
  selfCommand: string[];
  /** How users type the sandbox commands, e.g. "archil sandbox". */
  commandName: string;
  setExitCode: (code: number) => void;
  runSsh: (args: string[], env: NodeJS.ProcessEnv) => Promise<number>;
}

/** Resumes a paused sandbox or cold-starts a stopped one, showing progress. */
export async function wakeSandbox(ui: Ui, sandbox: Sandbox): Promise<void> {
  if (sandbox.status === "paused") {
    await ui.step(`Resuming ${sandbox.name}`, () => sandbox.resume(), `Resumed ${sandbox.name}`);
  } else if (sandbox.status === "stopped" || sandbox.status === "exited" || sandbox.status === "failed") {
    await ui.step(`Starting ${sandbox.name}`, () => sandbox.start(), `Started ${sandbox.name}`);
  }
  if (sandbox.status !== "running") {
    throw new Error(`Sandbox '${sandbox.name}' is ${sandbox.status}; wait for it to settle and try again`);
  }
}

export function addAccessCommands(context: AccessContext): void {
  addDesktopCommand(context);
  addForwardCommand(context);
  addSshCommands(context);
}

/** Waits for Ctrl-C (or SIGTERM/SIGHUP). */
function untilInterrupted(signals: NodeJS.Process): Promise<void> {
  return new Promise((resolve) => {
    const names = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
    const done = () => {
      for (const name of names) signals.off(name, done);
      resolve();
    };
    for (const name of names) signals.on(name, done);
  });
}

/**
 * Opens a private tunnel to `port`, prints `summary`, shows a live status line
 * until Ctrl-C, then closes the tunnel and revokes its token.
 */
async function serveTunnel(
  context: AccessContext,
  sandbox: Sandbox,
  port: number,
  requestedLocalPort: number | undefined,
  describe: (localPort: number) => { url: string; rows: Array<[string, string]>; json: Record<string, unknown> },
  status: (activity: PortTunnelActivity) => string,
  open: boolean,
  outputFormat: OutputFormat,
): Promise<void> {
  const { ui, signals, now } = context;
  const { style } = ui;
  let activity: PortTunnelActivity = { connections: 0, websockets: 0 };
  let live: ReturnType<Ui["live"]> | undefined;
  const started = now();
  const statusLine = () =>
    `${style.green("●")} ${style.bold("Live")}  ${status(activity)} ${style.dim("·")} up ${formatDuration(now() - started)} ${style.dim("· Ctrl-C to stop")}`;

  const { access, tunnel } = await ui.step("Opening private tunnel", async () => {
    const access = await sandbox.createPortToken(port, { ttl: TUNNEL_TOKEN_TTL });
    const tunnelOptions = (localPort: number): PortTunnelOptions => ({
      hostname: access.hostname,
      portToken: access.token,
      localPort,
      onActivity: (next) => {
        activity = next;
        live?.update(statusLine());
      },
    });
    try {
      const tunnel = await context.openTunnel(tunnelOptions(requestedLocalPort ?? port))
        .catch((error: NodeJS.ErrnoException) => {
          // Taken, or privileged (ports below 1024 on Linux): use any free port instead.
          if (requestedLocalPort !== undefined || (error.code !== "EADDRINUSE" && error.code !== "EACCES")) throw error;
          return context.openTunnel(tunnelOptions(0));
        });
      return { access, tunnel };
    } catch (error) {
      await sandbox.deletePortToken(access.id).catch(() => {});
      throw error;
    }
  }, "Private tunnel open");

  // The sandbox's idle timer only runs while it has no process connections,
  // and tunnel traffic isn't one, so hold a do-nothing process for the tunnel's lifetime.
  const keepalive = await sandbox.run("exec tail -f /dev/null", { collectOutput: false, timeoutSeconds: KEEPALIVE_MAX_SECONDS })
    .catch(() => {
      ui.warn("Couldn't keep the sandbox awake; it may pause after its idle timeout.");
      return undefined;
    });

  // Port tokens expire; swap in a fresh one before this one does.
  let currentAccess = access;
  let closing = false;
  let renewing: Promise<void> | undefined;
  const renewal = setInterval(() => {
    if (renewing) return;
    renewing = (async () => {
      const next = await sandbox.createPortToken(port, { ttl: TUNNEL_TOKEN_TTL });
      if (closing) {
        // The tunnel closed while this token was being made; nothing will use it.
        await sandbox.deletePortToken(next.id).catch(() => {});
        return;
      }
      tunnel.setPortToken(next.token);
      const previous = currentAccess;
      currentAccess = next;
      await sandbox.deletePortToken(previous.id).catch(() => {});
    })()
      .catch(() => ui.warn("Couldn't renew the tunnel's access token; new connections may fail once it expires."))
      .finally(() => { renewing = undefined; });
  }, TUNNEL_TOKEN_RENEW_MS);
  renewal.unref?.();

  const { url, rows, json } = describe(tunnel.port);
  if (outputFormat === "json") context.output(JSON.stringify(json, null, 2));
  else if (!context.stdout.isTTY || !ui.interactive) context.output(url);
  if (ui.interactive) {
    ui.blank();
    ui.details(rows);
    ui.blank();
  }
  if (open) openUrlQuietly(context, url);
  live = ui.live(statusLine());
  const ticker = setInterval(() => live?.update(statusLine()), 1000);
  try {
    await untilInterrupted(signals);
  } finally {
    clearInterval(ticker);
    clearInterval(renewal);
    closing = true;
    live.stop();
  }
  const uptime = formatDuration(now() - started);
  // Let a renewal already in flight finish, so the token it made is revoked below (or by itself).
  await renewing;
  await tunnel.close();
  await keepalive?.kill().catch(() => {});
  await keepalive?.disconnect().catch(() => {});
  await sandbox.deletePortToken(currentAccess.id).catch(() => {});
  await sandbox.processes.disconnect().catch(() => {});
  ui.success(`Closed tunnel after ${uptime} and revoked its access token`);
}

function openUrlQuietly(context: AccessContext, url: string): void {
  try {
    context.openUrl(url);
  } catch {
    // The URL is printed either way.
  }
}

function link(ui: Ui, url: string): string {
  return ui.style.cyan(ui.style.underline(url));
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function addDesktopCommand(context: AccessContext): void {
  const { program, ui, output } = context;
  context.formatOption(program.command("desktop <id|name>")
    .description("Open a sandbox's desktop in your browser")
    .addHelpText("after", `
By default the desktop stays private: a short-lived Archil port token and a
tunnel on localhost carry the connection, and the command runs until Ctrl-C.
--share instead publishes a public link that anyone can use to see and control
the desktop until you run --unshare.
`))
    .option("--share", "Print a public viewer link instead of opening a private tunnel")
    .option("--unshare", "Remove the public link, invalidate old links, and disconnect viewers")
    .option("--port <port>", "Local tunnel port (default: 6080, or any free port if it is taken)")
    .option("--no-open", "Print the URL without opening a browser")
    .action(async (target: string, options: { output: OutputFormat; share?: boolean; unshare?: boolean; port?: string; open: boolean }) => {
      if (options.share && options.unshare) throw new Error("Pass either --share or --unshare, not both");
      const localPort = optionalInteger(options.port, "Port", 1, 65_535);
      const sandbox = await context.resolve(target);
      await wakeSandbox(ui, sandbox);
      try {
        await openDesktop(context, sandbox, options, localPort);
      } finally {
        // An idle process connection otherwise keeps the CLI alive for a few seconds.
        await sandbox.processes.disconnect().catch(() => {});
      }
    });
}

async function openDesktop(
  context: AccessContext,
  sandbox: Sandbox,
  options: { output: OutputFormat; share?: boolean; unshare?: boolean; open: boolean },
  localPort: number | undefined,
): Promise<void> {
  const { ui, output } = context;
  const { style } = ui;
  if (options.unshare) {
    await ui.step(`Unpublishing ${sandbox.name}`, () => unshareDesktop(sandbox), `Unpublished ${sandbox.name}; old links stop working and viewers are disconnected`);
    if (options.output === "json") output(JSON.stringify({ id: sandbox.id, name: sandbox.name, url: null, shared: false }, null, 2));
    else if (!ui.interactive) output(`Unshared '${sandbox.name}'; old links no longer work.`);
    return;
  }

  const token = await ui.step("Starting desktop", () => startDesktop(sandbox), "Desktop running");
  const deskName = style.bold(sandbox.name);
  if (options.share) {
    const url = await ui.step("Publishing desktop", () => shareDesktop(sandbox, token), "Published");
    if (options.output === "json") output(JSON.stringify({ id: sandbox.id, name: sandbox.name, url, shared: true }, null, 2));
    else if (!context.stdout.isTTY || !ui.interactive) output(url);
    if (ui.interactive) {
      ui.blank();
      ui.details([["Desktop", link(ui, url)], ["Sandbox", deskName]]);
      ui.blank();
      ui.warn(`Anyone with this link can see and control the desktop. Revoke it with ${style.bold(`${context.commandName} desktop ${sandbox.name} --unshare`)}`);
    }
    return;
  }

  await serveTunnel(
    context,
    sandbox,
    DESKTOP_PORT,
    localPort,
    (port) => {
      const url = `http://localhost:${port}${viewerPath(token)}`;
      return {
        url,
        rows: [
          ["Desktop", link(ui, url)],
          ["Sandbox", `${deskName} ${style.dim(`· ${sandbox.vcpuCount} vCPU · ${Math.round(sandbox.memSizeMiB / 1024)} GiB`)}`],
          ["Access", `private to this machine ${style.dim(`· token expires in ${TUNNEL_TOKEN_TTL}`)}`],
          ...(options.open ? [["Browser", "opened in your default browser"] as [string, string]] : []),
        ],
        json: { id: sandbox.id, name: sandbox.name, url, shared: false },
      };
    },
    (activity) => plural(activity.websockets, "viewer"),
    options.open,
    options.output,
  );
}

function addForwardCommand(context: AccessContext): void {
  const { program, ui } = context;
  context.formatOption(program.command("forward <id|name> <port>")
    .description("Forward a sandbox's HTTP port to localhost, privately")
    .addHelpText("after", `
The port stays private: a short-lived Archil port token and a tunnel on
localhost carry the traffic until Ctrl-C. HTTP and WebSocket services work;
other protocols (databases, raw TCP) don't, because Archil authenticates the
first HTTP request on each connection.

Examples:
  archil sandbox forward dev 3000
  archil sandbox forward dev 8888 --local-port 9999
`))
    .option("--local-port <port>", "Local port (default: the same port, or any free port if it is taken)")
    .option("--open", "Open the forwarded URL in your browser")
    .action(async (target: string, remotePort: string, options: { output: OutputFormat; localPort?: string; open?: boolean }) => {
      const port = optionalInteger(remotePort, "Port", 1, 65_535)!;
      const localPort = optionalInteger(options.localPort, "Local port", 1, 65_535);
      const sandbox = await context.resolve(target);
      await wakeSandbox(ui, sandbox);
      const { style } = ui;
      await serveTunnel(
        context,
        sandbox,
        port,
        localPort,
        (actual) => {
          const url = `http://localhost:${actual}`;
          return {
            url,
            rows: [
              ["Forwarding", `${link(ui, url)} ${style.dim("→")} ${style.bold(sandbox.name)}:${port}`],
              ["Access", `private to this machine ${style.dim(`· HTTP and WebSocket only · token expires in ${TUNNEL_TOKEN_TTL}`)}`],
            ],
            json: { id: sandbox.id, name: sandbox.name, port, url },
          };
        },
        (activity) => plural(activity.connections, "connection"),
        options.open ?? false,
        options.output,
      );
    });
}

function addSshCommands(context: AccessContext): void {
  const { program, ui } = context;
  const proxyArgs = () => {
    const { profile } = context.credentials();
    return [...context.selfCommand, ...(profile ? ["--profile", profile] : [])];
  };

  program.command("ssh <id|name> [command...]")
    .description("Open an SSH session (or run a command) in a sandbox")
    .addHelpText("after", `
Uses real SSH, so ssh options, port forwarding (-L), and agent forwarding work.
The connection runs over the Archil API; no port is opened. The first
connection installs openssh-server if the image doesn't have it.

Arguments after the sandbox go to ssh; put -- before any that start with a dash:
  archil sandbox ssh dev
  archil sandbox ssh dev -- uname -a
  archil sandbox ssh dev -- -L 5432:localhost:5432
For scp, rsync, VS Code, and Cursor, run 'ssh-config --install' once and use
the host <sandbox-name>${SSH_HOST_SUFFIX}.
`)
    .action(async (target: string, command: string[]) => {
      const credentials = context.credentials();
      await ensureKeyWithProgress(ui);
      // OpenSSH reads options after the host too, so `-L ...` and a remote
      // command can both follow it.
      const code = await context.runSsh(
        [...sshOptions(proxyArgs()), `${sshTarget(target)}${SSH_HOST_SUFFIX}`, ...command],
        {
          ...process.env,
          ARCHIL_API_KEY: credentials.apiKey,
          ARCHIL_REGION: credentials.region,
          ...(credentials.baseUrl ? { ARCHIL_BASE_URL: credentials.baseUrl } : {}),
        },
      );
      context.setExitCode(code);
    });

  program.command("ssh-proxy <host>")
    .description("Connect ssh's stdin/stdout to a sandbox (used as an ssh ProxyCommand)")
    .action(async (host: string) => {
      const publicKey = await ensureSshKey();
      const sandbox = await context.resolve(sshTarget(host));
      await wakeSandbox(ui, sandbox);
      const notify = (message: string) => ui.info(message);
      const { sshd, hostKey } = await prepareSandboxSsh(sandbox, publicKey, notify);
      await rememberHostKey(sshKnownHostsPath(), host, hostKey);
      context.setExitCode(await relaySshd(sandbox, sshd, context.stdin, context.stdout, context.stderr));
    });

  program.command("ssh-config")
    .description("Print (or --install) the ssh config that makes <sandbox>.archil hosts work")
    .option("--install", "Write ~/.ssh/archil_config and include it from the top of ~/.ssh/config")
    .action(async (options: { install?: boolean }) => {
      await ensureKeyWithProgress(ui);
      const block = sshConfigBlock(proxyArgs());
      if (context.selfCommand.some((part) => part.includes(`${"/"}_npx${"/"}`))) {
        ui.warn("This config points at a temporary npx copy of the CLI. Install it first so the path stays valid: npm install -g archil");
      }
      if (!options.install) {
        context.output(block.trimEnd());
        return;
      }
      const sshDir = join(homedir(), ".ssh");
      await mkdir(sshDir, { recursive: true, mode: 0o700 });
      // ssh_config takes the first value it finds for each option, so the
      // archil hosts go in their own file, included from the top of the
      // user's config, ahead of any `Host *` block that would override them.
      await writeFile(join(sshDir, SSH_INCLUDE_FILE), sshConfigBlock(proxyArgs()), { mode: 0o600 });
      const path = join(sshDir, "config");
      let existing = "";
      try {
        existing = await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await writeFile(path, withArchilInclude(existing), { mode: 0o600 });
      ui.success(`Added ${ui.style.bold(`*${SSH_HOST_SUFFIX}`)} hosts (${join("~/.ssh", SSH_INCLUDE_FILE)}, included at the top of ~/.ssh/config)`);
      ui.blank();
      ui.details([
        ["Shell", `ssh my-sandbox${SSH_HOST_SUFFIX}`],
        ["Copy", `scp ./file my-sandbox${SSH_HOST_SUFFIX}:/root/`],
        ["Editors", `Remote-SSH: Connect to Host... → my-sandbox${SSH_HOST_SUFFIX}`],
      ]);
    });
}

async function ensureKeyWithProgress(ui: Ui): Promise<string> {
  try {
    return (await readFile(`${sshKeyPath()}.pub`, "utf8")).trim();
  } catch {
    return ui.step("Creating an SSH key for Archil", () => ensureSshKey(), `Created SSH key ${sshKeyPath()}`);
  }
}

export function runSshProcess(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", args, { stdio: "inherit", env });
    child.on("error", (error: NodeJS.ErrnoException) => reject(error.code === "ENOENT"
      ? new Error("ssh isn't installed on this machine; install OpenSSH and try again")
      : error));
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}
