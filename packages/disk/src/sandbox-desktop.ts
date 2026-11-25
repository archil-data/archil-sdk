import type { Sandbox } from "./sandbox.js";

/**
 * Sandbox desktops: a Linux desktop (Ubuntu, XFCE, Firefox) served over VNC
 * through noVNC on {@link DESKTOP_PORT}, from the image at
 * {@link DESKTOP_IMAGE} (github.com/archil-data/sandbox-desktop). Inside the
 * sandbox, `desktopctl` runs the desktop as supervised services; the noVNC
 * server only connects a viewer that presents the desktop's token.
 *
 * Everything here runs commands through the sandbox process API, so it works
 * wherever the SDK does. To view a private desktop from Node, see
 * `openDesktopTunnel` in `disk/tunnel`.
 */

export const DESKTOP_IMAGE = "ghcr.io/archil-data/sandbox-desktop:latest";
export const DESKTOP_PORT = 6080;
/** A browser on the desktop is sluggish with less. */
export const DESKTOP_VCPUS = 2;
export const DESKTOP_MEMORY_MIB = 4096;
/**
 * Session cap for desktops. Viewer traffic doesn't count as sandbox activity,
 * so desktops run with idle expiry off and this cap instead.
 */
export const DESKTOP_MAX_TTL_SECONDS = 4 * 60 * 60;

const COMMAND_NOT_FOUND = 127;
const DISPLAY = "DISPLAY=:1";
const KEYS = /^[A-Za-z0-9_+ ]+$/;

export type DesktopMouseButton = "left" | "middle" | "right";
export type DesktopScrollDirection = "up" | "down" | "left" | "right";

/** Path on the desktop's noVNC server that opens the viewer and connects with `token`. */
export function desktopViewerPath(token: string): string {
  const params = new URLSearchParams({
    autoconnect: "1",
    resize: "remote",
    reconnect: "1",
    path: `websockify?token=${token}`,
  });
  return `/vnc.html?${params}`;
}

export class DesktopNotInstalledError extends Error {
  constructor(sandboxName: string) {
    super(
      `Sandbox '${sandboxName}' doesn't have the Archil desktop installed; create it with desktop: true or from an image based on ${DESKTOP_IMAGE}`,
    );
    this.name = "DesktopNotInstalledError";
  }
}

/** The desktop of one sandbox: `sandbox.desktop`. */
export class SandboxDesktop {
  /** @internal */
  constructor(private readonly sandbox: Sandbox) {}

  /**
   * Starts the desktop if it isn't running (safe to call repeatedly) and
   * returns the viewer token. Anyone holding the token can view and control
   * the desktop through a link to its port.
   */
  async start(): Promise<{ token: string }> {
    const { token } = JSON.parse(await this.run("desktopctl up")) as { token: string };
    return { token };
  }

  /** The current viewer token. `rotate` replaces it first; a fork should rotate so it doesn't share its parent's. */
  async token(options: { rotate?: boolean } = {}): Promise<string> {
    return (await this.run(options.rotate ? "desktopctl token --rotate" : "desktopctl token")).trim();
  }

  /**
   * Publishes the desktop on a public HTTPS hostname and returns a viewer
   * link. Anyone with the link can see and control the desktop until
   * {@link unshare}.
   */
  async share(): Promise<string> {
    const { token } = await this.start();
    const hostname = await this.sandbox.exposePort(DESKTOP_PORT);
    return `https://${hostname}${desktopViewerPath(token)}`;
  }

  /** Removes the public hostname, invalidates every existing link, and disconnects current viewers. */
  async unshare(): Promise<void> {
    await this.sandbox.unexposePort(DESKTOP_PORT);
    await this.run("desktopctl revoke");
  }

  /** A PNG of the whole screen. */
  async screenshot(): Promise<Uint8Array> {
    const encoded = await this.run(`${DISPLAY} scrot -o /tmp/.archil-desktop-shot.png && base64 -w0 /tmp/.archil-desktop-shot.png`);
    return decodeBase64(encoded.trim());
  }

  /** The screen size in pixels. */
  async size(): Promise<{ width: number; height: number }> {
    const [width, height] = (await this.run(`${DISPLAY} xdotool getdisplaygeometry`)).trim().split(/\s+/).map(Number);
    return { width: width!, height: height! };
  }

  async moveMouse(x: number, y: number): Promise<void> {
    await this.run(`${DISPLAY} xdotool mousemove ${coordinate(x)} ${coordinate(y)}`);
  }

  async click(x: number, y: number, options: { button?: DesktopMouseButton; double?: boolean } = {}): Promise<void> {
    const button = { left: 1, middle: 2, right: 3 }[options.button ?? "left"];
    const repeat = options.double ? " --repeat 2" : "";
    await this.run(`${DISPLAY} xdotool mousemove ${coordinate(x)} ${coordinate(y)} click${repeat} ${button}`);
  }

  async scroll(direction: DesktopScrollDirection, amount = 3): Promise<void> {
    const button = { up: 4, down: 5, left: 6, right: 7 }[direction];
    await this.run(`${DISPLAY} xdotool click --repeat ${count(amount)} ${button}`);
  }

  /** Types `text` into the focused window. */
  async type(text: string): Promise<void> {
    await this.run(`${DISPLAY} xdotool type --delay 12 -- "$ARCHIL_DESKTOP_TEXT"`, { ARCHIL_DESKTOP_TEXT: text });
  }

  /** Presses a key or chord in xdotool's syntax, e.g. "Return", "ctrl+l", "ctrl+shift+t". */
  async key(keys: string): Promise<void> {
    if (!KEYS.test(keys)) throw new Error(`Invalid key '${keys}'; use names like Return, ctrl+l, or alt+F4`);
    await this.run(`${DISPLAY} xdotool key -- $ARCHIL_DESKTOP_KEYS`, { ARCHIL_DESKTOP_KEYS: keys });
  }

  /** Starts a program on the desktop as its user, e.g. `["firefox", "https://archil.com"]`. It keeps running after this returns. */
  async launch(argv: string[]): Promise<void> {
    if (argv.length === 0) throw new Error("launch needs a program to run");
    await this.run(`desktopctl launch ${argv.map(shellQuote).join(" ")}`);
  }

  private async run(command: string, env?: Record<string, string>): Promise<string> {
    const result = await this.sandbox.exec(command, env ? { env } : undefined);
    if (result.exitCode === COMMAND_NOT_FOUND) throw new DesktopNotInstalledError(this.sandbox.name);
    if (result.exitCode !== 0) {
      const name = command.split(" ").find((word) => !word.includes("="));
      throw new Error(`${name} failed in sandbox '${this.sandbox.name}': ${(result.stderr || result.stdout).trim()}`);
    }
    return result.stdout;
  }
}

function coordinate(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid screen coordinate ${value}`);
  return Math.round(value);
}

function count(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 100) throw new Error(`Scroll amount must be an integer from 1 to 100`);
  return value;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
