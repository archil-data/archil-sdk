import { ProcessTerminal, TuiAltScreen } from "@earendil-works/pi-tui";
import { SandboxApp } from "./app.js";
import { SandboxModel, type SandboxService } from "./model.js";

export interface RunSandboxTuiOptions {
  service: SandboxService;
  profile?: string;
  region: string;
  pollIntervalMs?: number;
  isInputTTY?: boolean;
  isOutputTTY?: boolean;
}

export function requireInteractiveTerminal(
  input = process.stdin.isTTY,
  output = process.stdout.isTTY,
): void {
  if (!input || !output) {
    throw new Error("disk sandboxes requires an interactive terminal; use the disk SDK for non-interactive sandbox management");
  }
}

export async function runSandboxTui(options: RunSandboxTuiOptions): Promise<void> {
  requireInteractiveTerminal(options.isInputTTY, options.isOutputTTY);
  const terminal = new ProcessTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true });
  const model = new SandboxModel(options.service, options.pollIntervalMs);
  let resolveQuit!: () => void;
  const quit = new Promise<void>((resolve) => { resolveQuit = resolve; });
  const app = new SandboxApp(tui, model, {
    profile: options.profile,
    region: options.region,
    onQuit: resolveQuit,
  });
  const stop = () => resolveQuit();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  tui.setLayoutRoot(app);
  tui.setFocus(app);
  try {
    tui.start();
    model.startPolling();
    await quit;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    app.dispose();
    tui.stop({ preserveScreen: true });
  }
}
