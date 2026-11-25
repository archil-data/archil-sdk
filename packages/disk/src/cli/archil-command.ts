// The `archil` CLI: `archil disk ...` and `archil sandbox ...` in one place.
//
// The native Archil client (curl https://archil.com/install | sh) is also
// called `archil` and owns the mount commands (`archil mount`, `archil
// unmount`, `archil status`, ...). Whichever binary comes first on PATH
// receives every `archil` invocation, so this CLI hands any command it doesn't
// own to the native client. That keeps `archil mount` working when this one
// wins; when the native client wins, `archil disk|sandbox` only work once it
// forwards those commands here.

import { spawn } from "node:child_process";
import { accessSync, closeSync, constants, openSync, readSync, realpathSync } from "node:fs";
import { delimiter, join } from "node:path";
import { Command } from "./command.js";
import { addGlobalOptions, addProfileCommands } from "./common.js";
import { completionScript } from "./completion.js";
import { addDiskCommands } from "./disk-command.js";
import { addSandboxCommands, type SandboxCliDependencies } from "./sandbox-command.js";

const OWN_COMMANDS = new Set(["disk", "sandbox", "profile", "completion", "help", "__complete"]);
const GLOBAL_OPTIONS_WITH_VALUES = new Set(["-k", "--api-key", "-r", "--region", "--base-url", "--profile"]);
const FORWARDED_ENV = "ARCHIL_CLI_FORWARDED";
export const NATIVE_CLIENT_INSTALL = "curl https://archil.com/install | sh";

export function createArchilProgram(dependencies: SandboxCliDependencies): Command {
  const program = new Command()
    .name("archil")
    .description("Manage Archil disks and sandboxes")
    .version(dependencies.version)
    .addHelpText("after", `
Mount commands (mount, unmount, status, checkout, ...) belong to the Archil
client and are passed through to it. Install it with:
  ${NATIVE_CLIENT_INSTALL}
`);
  addGlobalOptions(program);
  addProfileCommands(program, dependencies.validateCredential);
  addDiskCommands(program.command("disk").description("Create, inspect, and run commands against disks"), program);
  addSandboxCommands(program.command("sandbox").description("Create and manage persistent sandboxes"), program, dependencies);
  program.command("completion <shell>")
    .description("Print a shell completion script: bash, zsh, or fish")
    .addHelpText("after", `
  source <(archil completion zsh)     # add to ~/.zshrc
  source <(archil completion bash)    # add to ~/.bashrc
  archil completion fish > ~/.config/fish/completions/archil.fish
`)
    .action((shell: string) => {
      (dependencies.stdout ?? process.stdout).write(completionScript(shell));
    });
  return program;
}

/** Index in `args` (argv without node and script) of the first command word, skipping global options and their values. */
export function firstCommandIndex(args: string[]): number {
  for (let index = 0; index < args.length; index++) {
    const token = args[index]!;
    if (token === "--") return index + 1 < args.length ? index + 1 : -1;
    if (GLOBAL_OPTIONS_WITH_VALUES.has(token)) {
      index++;
      continue;
    }
    if (!token.startsWith("-")) return index;
  }
  return -1;
}

export function firstCommand(args: string[]): string | undefined {
  const index = firstCommandIndex(args);
  return index === -1 ? undefined : args[index];
}

/** Whether `args` should go to the native client instead of this CLI. */
export function isNativeCommand(args: string[]): boolean {
  const command = firstCommand(args);
  return command !== undefined && !OWN_COMMANDS.has(command);
}

/**
 * Finds the native `archil` on PATH, skipping this CLI and any other copy of
 * it (npm installs those as node scripts or symlinks to them).
 */
export function findNativeClient(env: NodeJS.ProcessEnv, selfPath: string): string | undefined {
  const self = safeRealpath(selfPath);
  const names = process.platform === "win32" ? ["archil.exe"] : ["archil"];
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    for (const name of names) {
      const candidate = join(directory, name);
      try {
        accessSync(candidate, constants.X_OK);
      } catch {
        continue;
      }
      const resolved = safeRealpath(candidate);
      if (resolved === self || isNodeScript(resolved)) continue;
      return candidate;
    }
  }
  return undefined;
}

/** Runs the native client with `args` and resolves to the exit code to use. */
export async function forwardToNativeClient(args: string[], env: NodeJS.ProcessEnv, selfPath: string): Promise<number> {
  const command = firstCommand(args);
  if (env[FORWARDED_ENV]) {
    throw new Error(`'archil ${command}' was forwarded back from the Archil client, which doesn't handle it either`);
  }
  const native = findNativeClient(env, selfPath);
  if (!native) {
    throw new Error(`'archil ${command}' is a command of the Archil client, which isn't installed. Install it with:\n  ${NATIVE_CLIENT_INSTALL}`);
  }
  // The terminal delivers Ctrl-C to the client too; stay alive to report its exit.
  const ignore = () => {};
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const signal of signals) process.on(signal, ignore);
  try {
    return await new Promise<number>((resolve, reject) => {
      const child = spawn(native, args, { stdio: "inherit", env: { ...env, [FORWARDED_ENV]: "1" } });
      child.on("error", reject);
      child.on("exit", (code, signal) => resolve(code ?? (signal ? 128 + (signalNumber(signal) ?? 1) : 1)));
    });
  } finally {
    for (const signal of signals) process.off(signal, ignore);
  }
}

function signalNumber(signal: NodeJS.Signals): number | undefined {
  return ({ SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 } as Partial<Record<NodeJS.Signals, number>>)[signal];
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function isNodeScript(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const head = Buffer.alloc(128);
    const length = readSync(fd, head, 0, head.length, 0);
    const firstLine = head.subarray(0, length).toString().split("\n")[0]!;
    return firstLine.startsWith("#!") && firstLine.includes("node");
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
