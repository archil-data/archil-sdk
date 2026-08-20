import { createInterface } from "node:readline/promises";
import { spinner } from "@clack/prompts";
import { Command } from "commander";
import type { ArchilOptions } from "../archil.js";
import type { SandboxProcess, SandboxProcessResult } from "../sandbox-process.js";
import type { Sandbox, SandboxStatus } from "../sandbox.js";
import type { CreateSandboxRequest } from "../sandboxes.js";
import {
  addGlobalOptions,
  addProfileCommands,
  isProfileCommand,
  resolveProgramCredentials,
  type ProfileCredentialValidator,
} from "./common.js";
import {
  formatSandbox,
  formatSandboxList,
  parseOutputFormat,
  type OutputFormat,
} from "./sandbox-output.js";
import {
  parseCreateSandboxOptions,
  parseRunOptions,
  validateSandboxName,
  type CreateSandboxCliOptions,
} from "./sandbox-options.js";
import { runSandboxShell } from "./sandbox-shell.js";

export interface SandboxService {
  list(): Promise<Sandbox[]>;
  get(id: string): Promise<Sandbox>;
  create(request?: CreateSandboxRequest, options?: { wait?: boolean }): Promise<Sandbox>;
}

interface WritableOutput {
  write(data: string | Uint8Array): unknown;
}

interface SandboxCliDependencies {
  version: string;
  createClient(options: ArchilOptions): { sandboxes: SandboxService };
  stdout?: WritableOutput & { isTTY?: boolean };
  stderr?: WritableOutput & { isTTY?: boolean };
  stdin?: NodeJS.ReadStream;
  signals?: NodeJS.Process;
  confirm?: (question: string) => Promise<boolean>;
  setExitCode?: (code: number) => void;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  validateCredential?: ProfileCredentialValidator;
  forceExit?: (signal: NodeJS.Signals) => void;
}

type LifecycleAction = "start" | "pause" | "resume" | "stop" | "fork" | "delete";

export const SANDBOX_ACTIONS: Readonly<Record<SandboxStatus, readonly LifecycleAction[]>> = {
  running: ["pause", "stop", "fork"],
  paused: ["resume", "start", "stop", "fork"],
  stopped: ["start", "fork", "delete"],
  exited: ["start", "delete"],
  failed: ["start", "delete"],
  pending: [],
  pausing: [],
  stopping: [],
  deleting: [],
  deleted: [],
};

export async function resolveSandbox(service: SandboxService, idOrName: string): Promise<Sandbox> {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrName)) {
    return service.get(idOrName);
  }
  const sandboxes = await service.list();
  const byName = sandboxes.filter(({ name }) => name === idOrName);
  if (byName.length === 0) throw new Error(`No sandbox found with id or name '${idOrName}'`);
  if (byName.length > 1) {
    throw new Error(`Multiple sandboxes are named '${idOrName}'; pass an exact sandbox id`);
  }
  return byName[0]!;
}

function resultExitCode(result: SandboxProcessResult): number {
  return result.exitCode ?? (result.status === "completed" ? 0 : 1);
}

export function createSandboxProgram(dependencies: SandboxCliDependencies): Command {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const stdin = dependencies.stdin ?? process.stdin;
  const signals = dependencies.signals ?? process;
  const setExitCode = dependencies.setExitCode ?? ((code: number) => { process.exitCode = code; });
  const forceExit = dependencies.forceExit ?? (dependencies.signals ? (() => {}) : (signal: NodeJS.Signals) => { process.kill(process.pid, signal); });
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let service: SandboxService | undefined;
  const program = new Command()
    .name("sandbox")
    .description("Manage Archil sandboxes from the command line")
    .version(dependencies.version)
    .hook("preAction", async (_thisCommand, actionCommand) => {
      if (isProfileCommand(actionCommand)) return;
      const credentials = await resolveProgramCredentials(program);
      service = dependencies.createClient(credentials).sandboxes;
    });
  addGlobalOptions(program);
  addProfileCommands(program, dependencies.validateCredential);

  const output = (value: string) => stdout.write(`${value}\n`);
  const withSpinner = async <T>(label: string, enabled: boolean, operation: () => Promise<T>): Promise<T> => {
    if (!enabled || !stderr.isTTY) return operation();
    const progress = spinner({ output: stderr as NodeJS.WriteStream, withGuide: false });
    progress.start(label);
    try {
      return await operation();
    } finally {
      progress.clear();
    }
  };
  const requireService = () => {
    if (!service) throw new Error("Sandbox client was not configured");
    return service;
  };
  const formatOption = (command: Command) => command.option(
    "-o, --output <format>",
    "Output format: table | json",
    parseOutputFormat,
    "table" as OutputFormat,
  );
  const waitOption = (command: Command) => command.option("--no-wait", "Return after the operation is accepted");
  const confirmDestructive = async (question: string, yes: boolean): Promise<boolean> => {
    if (yes) return true;
    if (!stdin.isTTY || !stdout.isTTY) throw new Error("This operation requires --yes when stdin/stdout is non-interactive");
    if (dependencies.confirm) return dependencies.confirm(question);
    const prompt = createInterface({ input: stdin, output: stderr as NodeJS.WritableStream });
    try {
      return /^(y|yes)$/i.test((await prompt.question(`${question} [y/N] `)).trim());
    } finally {
      prompt.close();
    }
  };

  formatOption(program.command("list").description("List sandboxes")).action(async (options: { output: OutputFormat }) => {
    output(formatSandboxList(await requireService().list(), options.output));
  });

  formatOption(program.command("get <id|name>").description("Show sandbox details")).action(async (target: string, options: { output: OutputFormat }) => {
    output(formatSandbox(await resolveSandbox(requireService(), target), options.output));
  });

  const create = waitOption(formatOption(program.command("create [name]").description("Create a sandbox")))
    .option("--vcpu-count <count>", "Virtual CPU count (1-32)")
    .option("--mem-size-mib <mib>", "Memory in MiB (256-65536)")
    .option("--base-image <image>", "Public OCI image", "ubuntu:26.04")
    .option("--max-ttl-seconds <seconds>", "Maximum sandbox lifetime")
    .option("--max-concurrent-processes <count>", "Maximum attached processes")
    .option("--env <name=value>", "Set an environment variable (repeatable)", (value, previous: string[]) => [...previous, value], []);
  create.action(async (name: string | undefined, options: CreateSandboxCliOptions & { output: OutputFormat; wait: boolean }) => {
    const sandbox = await withSpinner("Creating sandbox", options.wait, () =>
      requireService().create(parseCreateSandboxOptions(name, options), { wait: options.wait }));
    output(formatSandbox(sandbox, options.output));
  });

  const addLifecycleCommand = (action: Exclude<LifecycleAction, "fork" | "delete">) => {
    const command = waitOption(formatOption(program.command(`${action} <id|name>`).description(`${action[0]!.toUpperCase()}${action.slice(1)} a sandbox`)));
    if (action === "start") command.option("-y, --yes", "Confirm cold-starting a paused sandbox");
    command.action(async (target: string, options: { output: OutputFormat; wait: boolean; yes?: boolean }) => {
      const sandbox = await resolveSandbox(requireService(), target);
      if (!SANDBOX_ACTIONS[sandbox.status].includes(action)) {
        throw new Error(`Cannot ${action} sandbox '${sandbox.name}' while it is ${sandbox.status}`);
      }
      if (action === "start" && sandbox.status === "paused" && !await confirmDestructive(`Cold-start '${sandbox.name}' and discard its memory snapshot?`, options.yes ?? false)) {
        if (options.output === "json") output(JSON.stringify({ id: sandbox.id, name: sandbox.name, action, cancelled: true }, null, 2));
        else output(`Cancelled cold-start of '${sandbox.name}'.`);
        return;
      }
      const labels: Record<Exclude<LifecycleAction, "fork" | "delete">, string> = {
        start: "Starting sandbox",
        pause: "Pausing sandbox",
        resume: "Resuming sandbox",
        stop: "Stopping sandbox",
      };
      await withSpinner(labels[action], options.wait, () => sandbox[action]({ wait: options.wait }));
      output(formatSandbox(sandbox, options.output));
    });
  };
  addLifecycleCommand("start");
  addLifecycleCommand("pause");
  addLifecycleCommand("resume");
  addLifecycleCommand("stop");

  waitOption(formatOption(program.command("fork <id|name> [new-name]").description("Fork a sandbox"))).action(
    async (target: string, name: string | undefined, options: { output: OutputFormat; wait: boolean }) => {
      const sandbox = await resolveSandbox(requireService(), target);
      if (!SANDBOX_ACTIONS[sandbox.status].includes("fork")) {
        throw new Error(`Cannot fork sandbox '${sandbox.name}' while it is ${sandbox.status}`);
      }
      const fork = await withSpinner("Forking sandbox", options.wait, () =>
        sandbox.fork({ name: validateSandboxName(name), wait: options.wait }));
      output(formatSandbox(fork, options.output));
    },
  );

  formatOption(program.command("delete <id|name>").description("Delete a sandbox permanently"))
    .action(async (target: string, options: { output: OutputFormat }) => {
      const sandbox = await resolveSandbox(requireService(), target);
      if (!SANDBOX_ACTIONS[sandbox.status].includes("delete")) {
        throw new Error(`Cannot delete sandbox '${sandbox.name}' while it is ${sandbox.status}`);
      }
      await withSpinner("Deleting sandbox", true, () => sandbox.delete());
      if (options.output === "json") output(JSON.stringify({ id: sandbox.id, name: sandbox.name, deleted: true }, null, 2));
      else output(`Deleted '${sandbox.name}' (${sandbox.id}).`);
    });

  const stableStatuses = ["running", "paused", "stopped", "exited", "failed"] as const satisfies readonly SandboxStatus[];
  formatOption(program.command("wait <id|name>").description("Wait for a sandbox to reach a stable state"))
    .option("--status <status>", "Stable status: running | paused | stopped | exited | failed", (value: string) => {
      if (!(stableStatuses as readonly string[]).includes(value)) {
        throw new Error(`Status must be one of: ${stableStatuses.join(", ")}`);
      }
      return value as typeof stableStatuses[number];
    })
    .option("--timeout <seconds>", "Maximum time to wait in seconds", "300")
    .action(async (target: string, options: { output: OutputFormat; status?: typeof stableStatuses[number]; timeout: string }) => {
      const timeoutSeconds = Number(options.timeout);
      if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1) {
        throw new Error("Wait timeout must be an integer of at least 1 second");
      }
      const sandbox = await resolveSandbox(requireService(), target);
      const deadline = now() + timeoutSeconds * 1000;
      await withSpinner(`Waiting for '${sandbox.name}'`, true, async () => {
        while (options.status ? sandbox.status !== options.status : !(stableStatuses as readonly SandboxStatus[]).includes(sandbox.status)) {
          const remaining = deadline - now();
          if (remaining <= 0) {
            const desired = options.status ? `status '${options.status}'` : "a stable state";
            throw new Error(`Timed out after ${timeoutSeconds} seconds waiting for sandbox '${sandbox.name}' to reach ${desired}; current status is '${sandbox.status}'`);
          }
          await sleep(Math.min(500, remaining));
          await sandbox.refresh();
        }
      });
      output(formatSandbox(sandbox, options.output));
    });

  formatOption(program.command("run <id|name> <command...>")
    .description("Run a one-shot command in a running sandbox")
    .addHelpText("after", `
Examples:
  sandbox run my-sandbox -- echo hello
  sandbox run my-sandbox -- sh -c 'echo "$HOME"'

Use -- before the command so its flags are not parsed as sandbox options.
`))
    .option("--env <name=value>", "Set an environment variable (repeatable)", (value, previous: string[]) => [...previous, value], [])
    .option("--timeout <seconds>", "Command timeout in seconds")
    .action(async (target: string, command: string[], options: { env: string[]; timeout?: string; output: OutputFormat }) => {
      const sandbox = await resolveSandbox(requireService(), target);
      if (sandbox.status !== "running") throw new Error(`Cannot run a command in sandbox '${sandbox.name}' while it is ${sandbox.status}`);
      const runOptions = parseRunOptions(options);
      let receivedStderr = false;
      let remote: SandboxProcess | undefined;
      let result: SandboxProcessResult | undefined;
      let terminationStarted = false;
      let resolveTermination!: (result: SandboxProcessResult) => void;
      let rejectTermination!: (error: Error) => void;
      const termination = new Promise<SandboxProcessResult>((resolve, reject) => {
        resolveTermination = resolve;
        rejectTermination = reject;
      });
      const removeSignalListeners = () => {
        signals.off("SIGINT", onSigint);
        signals.off("SIGTERM", onSigterm);
        signals.off("SIGHUP", onSighup);
      };
      const onSignal = (signal: NodeJS.Signals) => {
        if (!remote) return;
        if (terminationStarted) {
          removeSignalListeners();
          forceExit(signal);
          return;
        }
        terminationStarted = true;
        void remote.kill().then(
          () => resolveTermination({ status: "cancelled", exitReason: "terminated by local signal", stdout: remote?.stdout ?? "", stderr: remote?.stderr ?? "" }),
          (error: unknown) => rejectTermination(error instanceof Error ? error : new Error(String(error))),
        );
      };
      const onSigint = () => onSignal("SIGINT");
      const onSigterm = () => onSignal("SIGTERM");
      const onSighup = () => onSignal("SIGHUP");
      try {
        const shellCommand = command.map((argument) => argument === ""
          ? "''"
          : `'${argument.replaceAll("'", `'"'"'`)}'`).join(" ");
        remote = await sandbox.processes.start(shellCommand, {
          ...runOptions,
          collectOutput: options.output === "json",
          onOutput: options.output === "json" ? undefined : ({ stream, data }) => {
            if (stream === "stderr" && data.byteLength > 0) receivedStderr = true;
            return (stream === "stdout" ? stdout : stderr).write(data);
          },
        });
        signals.on("SIGINT", onSigint);
        signals.on("SIGTERM", onSigterm);
        signals.on("SIGHUP", onSighup);
        result = await Promise.race([remote.wait(), termination]);
        if (options.output === "json") {
          output(JSON.stringify(result, null, 2));
        } else if (result.status !== "completed" && !receivedStderr) {
          let diagnostic: string;
          if (result.status === "timed_out") {
            diagnostic = `Process timed out${runOptions.timeoutSeconds === undefined ? "" : ` after ${runOptions.timeoutSeconds} second${runOptions.timeoutSeconds === 1 ? "" : "s"}`}`;
          } else if (result.status === "failed") {
            diagnostic = `Process failed${result.exitCode === undefined ? "" : ` with exit code ${result.exitCode}`}`;
          } else {
            diagnostic = "Process cancelled";
          }
          stderr.write(`${diagnostic}${result.exitReason ? `: ${result.exitReason}` : ""}\n`);
        }
        setExitCode(resultExitCode(result));
      } finally {
        removeSignalListeners();
        if (remote && !result && !terminationStarted) await remote.kill().catch(() => {});
        await remote?.disconnect().catch(() => {});
      }
    });

  formatOption(program.command("shell <id|name>")
    .description("Open an interactive shell in a running sandbox"))
    .action(async (target: string, options: { output: OutputFormat }) => {
      const sandbox = await resolveSandbox(requireService(), target);
      if (sandbox.status !== "running") throw new Error(`Cannot open a shell in sandbox '${sandbox.name}' while it is ${sandbox.status}`);
      const shellOutput = options.output === "json" ? stderr as NodeJS.WriteStream : stdout as NodeJS.WriteStream;
      const result = await runSandboxShell({ sandbox, stdin, stdout: shellOutput, stderr, signals, forceExit });
      if (options.output === "json") output(JSON.stringify(result, null, 2));
      setExitCode(resultExitCode(result));
    });

  return program;
}
