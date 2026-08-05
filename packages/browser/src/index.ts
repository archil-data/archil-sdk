import { createSandbox, type Sandbox, type SandboxExec } from "disk";

const browserImage = "ghcr.io/archil-data/browser:0.0.1";
const serviceName = "archil-browser";
const servicePort = 9222;
const launcherPath = "/opt/archil-browser/launcher.mjs";

export interface BrowserStartResult {
  cdpUrl: string;
}

export interface ArchilBrowser {
  start(): Promise<BrowserStartResult>;
  stop(): Promise<void>;
}

export interface BrowserSandbox {
  sandbox: Sandbox;
  browser: ArchilBrowser;
}

export async function createBrowserSandbox(): Promise<BrowserSandbox> {
  const sandbox = await createSandbox({ baseImage: browserImage }, { timeoutMs: 600_000 });
  return { sandbox, browser: createBrowser(sandbox) };
}

function createBrowser(sandbox: Sandbox): ArchilBrowser {
  return {
    async start() {
      const service = JSON.parse(
        await run(
          sandbox,
          [
            `archil-sandbox services create ${serviceName}`,
            "--env HOME=/home/node",
            "--dir /home/node",
            `--tcp-port ${servicePort}`,
            `-- node ${launcherPath}`,
          ].join(" "),
        ),
      ) as { hostname: string };
      try {
        return { cdpUrl: await waitForCdp(service.hostname) };
      } catch (error) {
        await run(sandbox, `archil-sandbox services delete ${serviceName}`);
        throw error;
      }
    },

    async stop() {
      await run(sandbox, `archil-sandbox services delete ${serviceName}`);
    },
  };
}

async function run(sandbox: Sandbox, command: string): Promise<string> {
  const result = await sandbox.exec(command);
  if (result.status !== "completed" || result.exitCode !== 0) {
    throw commandError(result);
  }
  return result.stdout ?? "";
}

function commandError(result: SandboxExec): Error {
  const detail = result.stderr ?? result.exitReason ?? `status ${result.status}`;
  return new Error(`Archil browser command failed: ${detail}`);
}

async function waitForCdp(hostname: string): Promise<string> {
  const endpoint = `https://${hostname}/json/version`;
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        const version = (await response.json()) as { webSocketDebuggerUrl: string };
        const chromeUrl = new URL(version.webSocketDebuggerUrl);
        return `wss://${hostname}${chromeUrl.pathname}${chromeUrl.search}`;
      }
    } catch {
      // Chrome and the public endpoint become ready asynchronously.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for Chromium at ${endpoint}`);
}
