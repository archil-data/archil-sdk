// Support for the VNC desktop image (github.com/archil-data/sandbox-desktop).
// Inside the sandbox, `desktopctl` runs Xtigervnc, XFCE, and noVNC/websockify
// as supervised services; websockify listens on DESKTOP_PORT and only proxies
// to VNC for requests that carry the desktop's viewer token.

import type { Sandbox } from "../sandbox.js";

export const DESKTOP_IMAGE = "ghcr.io/archil-data/sandbox-desktop:latest";
export const DESKTOP_PORT = 6080;
/** A browser on the desktop is sluggish below this. */
export const DESKTOP_VCPUS = 2;
export const DESKTOP_MEMORY_MIB = 4096;
/** Session cap for desktops. Viewer traffic doesn't count as activity, so they run with idle expiry off. */
export const DESKTOP_MAX_TTL_SECONDS = 4 * 60 * 60;

const COMMAND_NOT_FOUND = 127;

/** Starts the desktop services if needed (idempotent) and returns the viewer token. */
export async function startDesktop(sandbox: Sandbox): Promise<string> {
  const stdout = await desktopctl(sandbox, "up");
  const { token } = JSON.parse(stdout) as { token: string };
  return token;
}

/** Path on the noVNC server that opens the viewer and connects with `token`. */
export function viewerPath(token: string): string {
  const params = new URLSearchParams({
    autoconnect: "1",
    resize: "remote",
    reconnect: "1",
    path: `websockify?token=${token}`,
  });
  return `/vnc.html?${params}`;
}

/** Publishes the desktop on a public hostname; anyone with the returned link controls it. */
export async function shareDesktop(sandbox: Sandbox, token: string): Promise<string> {
  const hostname = await sandbox.exposePort(DESKTOP_PORT);
  return `https://${hostname}${viewerPath(token)}`;
}

/** Removes the public hostname, invalidates old links, and disconnects current viewers. */
export async function unshareDesktop(sandbox: Sandbox): Promise<void> {
  await sandbox.unexposePort(DESKTOP_PORT);
  await desktopctl(sandbox, "revoke");
}

async function desktopctl(sandbox: Sandbox, command: string): Promise<string> {
  const result = await sandbox.exec(`desktopctl ${command}`);
  if (result.exitCode === COMMAND_NOT_FOUND) {
    throw new Error(
      `Sandbox '${sandbox.name}' doesn't have the Archil desktop installed; create it with --desktop or from an image based on ${DESKTOP_IMAGE}`,
    );
  }
  if (result.exitCode !== 0) {
    throw new Error(`desktopctl ${command} failed in sandbox '${sandbox.name}': ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout;
}
