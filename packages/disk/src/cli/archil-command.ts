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
import { addGlobalOptions, addProfileCommands, type CliGlobalOptions } from "./common.js";
import { validateCredentialAndResolveRegion } from "./credential-validation.js";
import { deleteProfileCredential, resolveCliCredentials, writeProfileCredential } from "./credentials.js";
import { consoleUrl, LoginDeniedError, startLoginSession } from "./login.js";
import { deleteProfile, loadProfiles, saveProfiles } from "./profiles.js";
import { createUi } from "./ui.js";
import { completionScript } from "./completion.js";
import { addDiskCommands } from "./disk-command.js";
import { addSandboxCommands, openInBrowser, type SandboxCliDependencies } from "./sandbox-command.js";

const OWN_COMMANDS = new Set(["disk", "sandbox", "profile", "login", "logout", "whoami", "completion", "help", "__complete"]);
const GLOBAL_OPTIONS_WITH_VALUES = new Set(["-k", "--api-key", "-r", "--region", "--base-url", "--profile"]);
const SKIP_ENV = "ARCHIL_CLI_FORWARD_SKIP";
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
  addAccountCommands(program, dependencies);
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
 * Finds the native `archil` on PATH. It skips this CLI, other npm copies of it
 * (node scripts or symlinks to them), and every binary an earlier hop already
 * tried. Package managers also install this CLI behind wrappers that don't look
 * like node (pnpm's sh shims, Volta and asdf binaries); if one of those is
 * picked, it lands back here, skips itself via SKIP_ENV, and moves on.
 */
export function findNativeClient(env: NodeJS.ProcessEnv, selfPath: string): string | undefined {
  const skip = new Set([safeRealpath(selfPath), ...skippedPaths(env)]);
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
      if (skip.has(resolved) || isNodeScript(resolved)) continue;
      return candidate;
    }
  }
  return undefined;
}

function skippedPaths(env: NodeJS.ProcessEnv): string[] {
  return (env[SKIP_ENV] ?? "").split(delimiter).filter(Boolean).map(safeRealpath);
}

/** Runs the native client with `args` and resolves to the exit code to use. */
export async function forwardToNativeClient(args: string[], env: NodeJS.ProcessEnv, selfPath: string): Promise<number> {
  const command = firstCommand(args);
  const native = findNativeClient(env, selfPath);
  if (!native) {
    throw new Error(`'archil ${command}' is a command of the Archil client, which isn't installed. Install it with:\n  ${NATIVE_CLIENT_INSTALL}`);
  }
  // Each hop adds what it tried, so a wrapper that runs this CLI again can't loop.
  const skip = [...skippedPaths(env), safeRealpath(selfPath), safeRealpath(native)].join(delimiter);
  // The terminal delivers Ctrl-C to the client too; stay alive to report its exit.
  const ignore = () => {};
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const signal of signals) process.on(signal, ignore);
  try {
    return await new Promise<number>((resolve, reject) => {
      const child = spawn(native, args, { stdio: "inherit", env: { ...env, [SKIP_ENV]: skip } });
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

/**
 * Where `archil login` saves a key when no --profile is given: replace the
 * profile an earlier login made for this endpoint, otherwise use the region's
 * name, and never overwrite a profile someone created by hand.
 */
export function loginProfileName(
  profiles: Record<string, { region: string; baseUrl?: string; apiKeyId?: string; account?: string }>,
  region: string,
  baseUrl: string | undefined,
  account: string | undefined,
  requested?: string,
): string {
  if (requested !== undefined) {
    const existing = profiles[requested];
    if (existing && existing.apiKeyId === undefined) {
      throw new Error(`Profile '${requested}' already exists and wasn't created by 'archil login'; pick another name with --profile, or delete it with 'archil profile delete ${requested}'`);
    }
    return requested;
  }
  const previousLogin = Object.entries(profiles).find(([, profile]) =>
    profile.apiKeyId !== undefined && profile.region === region && profile.baseUrl === baseUrl && profile.account === account);
  if (previousLogin) return previousLogin[0];
  let name = region;
  for (let suffix = 2; profiles[name]; suffix++) name = `${region}-${suffix}`;
  return name;
}

function addAccountCommands(program: Command, dependencies: SandboxCliDependencies): void {
  const stderr = dependencies.stderr ?? process.stderr;
  const signals = dependencies.signals ?? process;
  const ui = createUi(stderr);
  const { style } = ui;
  const validate = dependencies.validateCredential ?? validateCredentialAndResolveRegion;

  program.command("login")
    .description("Sign in through your browser and save the key as a profile")
    .option("--no-browser", "Print the sign-in link instead of opening a browser")
    .addHelpText("after", `
Opens the Archil console, where you approve access for this machine. The
console creates an API key named "CLI on <hostname>" and hands it back to this
command, which saves it as a profile (named after its region unless you pass
--profile) and makes that profile the default.

Without a browser on this machine (CI, a remote shell), create a key in the
console and run 'archil profile create', or set ARCHIL_API_KEY and ARCHIL_REGION.
`)
    .action(async (options: { browser: boolean }) => {
      const global = program.opts<CliGlobalOptions>();
      const session = await startLoginSession();
      const cancel = () => session.close();
      signals.once("SIGINT", cancel);
      try {
        if (options.browser) {
          (dependencies.openUrl ?? openInBrowser)(session.url);
          ui.info("Opened the Archil console in your browser to approve this sign-in.");
          ui.details([["Link", style.dim(session.url)]]);
        } else {
          ui.info("Open this link in a browser on this machine to approve the sign-in:");
          stderr.write(`\n  ${style.cyan(style.underline(session.url))}\n\n`);
        }
        const grant = await ui.step("Waiting for approval in the browser", () => session.grant, "Approved in the browser")
          .catch((error: unknown) => {
            if (error instanceof LoginDeniedError) throw new Error("Sign-in was cancelled in the browser; nothing was saved");
            throw error;
          });
        const region = await ui.step("Checking the new key", () =>
          validate({ apiKey: grant.apiKey, region: grant.region, baseUrl: grant.baseUrl }), "Key works");

        const config = await loadProfiles();
        const name = loginProfileName(config.profiles, region, grant.baseUrl, grant.account, global.profile);
        await writeProfileCredential(name, grant.apiKey);
        config.profiles[name] = { region, baseUrl: grant.baseUrl, apiKeyId: grant.keyId, account: grant.account };
        config.currentProfile = name;
        await saveProfiles(config);

        const where = name === region ? "" : `, ${region}`;
        ui.success(`Signed in${grant.account ? ` to ${style.bold(grant.account)}` : ""} as profile ${style.bold(name)} ${style.dim(`(now the default${where})`)}`);
        ui.blank();
        ui.details([["Try", "archil sandbox create my-desk --desktop"], ["", "archil sandbox list"]]);
        const overriding = ["ARCHIL_API_KEY", "ARCHIL_REGION", "ARCHIL_BASE_URL", "ARCHIL_PROFILE"].filter((name) => process.env[name]);
        if (overriding.length > 0) {
          ui.blank();
          ui.warn(`${overriding.join(", ")} ${overriding.length === 1 ? "is" : "are"} set in your environment and ${overriding.length === 1 ? "takes" : "take"} precedence over this profile.`);
          ui.details([["Fix", `unset ${overriding.join(" ")}  ${style.dim("(and remove it from your shell profile)")}`]]);
        }
      } finally {
        signals.off("SIGINT", cancel);
        session.close();
      }
    });

  program.command("logout")
    .description("Delete the current profile and its saved key from this machine")
    .action(async () => {
      const global = program.opts<CliGlobalOptions>();
      const config = await loadProfiles();
      const name = global.profile ?? process.env.ARCHIL_PROFILE ?? config.currentProfile;
      const profile = name ? config.profiles[name] : undefined;
      if (!name || !profile) {
        ui.info("No profile is signed in.");
      } else {
        await deleteProfileCredential(name);
        await deleteProfile(name);
        ui.success(`Signed out of ${style.bold(name)}; its key is no longer saved on this machine`);
        // API keys can't revoke themselves; only a signed-in console session can.
        if (profile.apiKeyId) {
          ui.info(`The key still works until you revoke it: ${style.cyan(style.underline(`${consoleUrl()}/api-keys`))}`);
        }
      }
      if (process.env.ARCHIL_API_KEY) ui.warn("ARCHIL_API_KEY is still set in your environment, so commands keep using it.");
    });

  program.command("whoami")
    .description("Show which account and profile commands use, and check the credentials")
    .action(async () => {
      const global = program.opts<CliGlobalOptions>();
      const config = await loadProfiles();
      const credentials = await resolveCliCredentials(global, config);
      const profile = credentials.profile ? config.profiles[credentials.profile] : undefined;
      const fromEnvironment = Boolean(global.apiKey ?? process.env.ARCHIL_API_KEY);
      await ui.step("Checking credentials", () => validate(credentials), "Credentials work");
      ui.blank();
      ui.details([
        ...(profile?.account ? [["Account", style.bold(profile.account)] as [string, string]] : []),
        ["Profile", fromEnvironment ? style.dim("none (ARCHIL_API_KEY)") : credentials.profile ?? style.dim("none")],
        ["Region", credentials.region],
        ...(credentials.baseUrl ? [["Endpoint", credentials.baseUrl] as [string, string]] : []),
        ["Key", `…${credentials.apiKey.slice(-4)}`],
      ]);
    });
}
