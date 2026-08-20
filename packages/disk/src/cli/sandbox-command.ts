import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import type { ArchilOptions } from "../archil.js";
import type { SandboxProcessResult } from "../sandbox-process.js";
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
  create(request?: CreateSandboxRequest, options?: { wait?: boolean }): Promise<Sandbox>;
}

interface WritableOutput {
  write(data: string | Uint8Array): unknown;
}

interface SandboxCliDependencies {
  version: string;
  createClient(options: ArchilOptions): { sandboxes: SandboxService };
  stdout?: WritableOutput & { isTTY?: boolean };
  stderr?: WritableOutput;
  stdin?: NodeJS.ReadStream;
  signals?: NodeJS.Process;
  confirm?: (question: string) => Promise<boolean>;
  setExitCode?: (code: number) => void;
  validateCredential?: ProfileCredentialValidator;
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
  const sandboxes = await service.list();
  const byId = sandboxes.find(({ id }) => id === idOrName);
  if (byId) return byId;
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
    .option("--port <port[/protocol]>", "Expose a container port (repeatable)", (value, previous: string[]) => [...previous, value], [])
    .option("--env <name=value>", "Set an environment variable (repeatable)", (value, previous: string[]) => [...previous, value], []);
  create.action(async (name: string | undefined, options: CreateSandboxCliOptions & { output: OutputFormat; wait: boolean }) => {
    const sandbox = await requireService().create(parseCreateSandboxOptions(name, options), { wait: options.wait });
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
        output(`Cancelled cold-start of '${sandbox.name}'.`);
        return;
      }
      await sandbox[action]({ wait: options.wait });
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
      const fork = await sandbox.fork({ name: validateSandboxName(name), wait: options.wait });
      output(formatSandbox(fork, options.output));
    },
  );

  formatOption(program.command("delete <id|name>").description("Delete a sandbox permanently"))
    .action(async (target: string, options: { output: OutputFormat }) => {
      const sandbox = await resolveSandbox(requireService(), target);
      if (!SANDBOX_ACTIONS[sandbox.status].includes("delete")) {
        throw new Error(`Cannot delete sandbox '${sandbox.name}' while it is ${sandbox.status}`);
      }
      await sandbox.delete();
      if (options.output === "json") output(JSON.stringify({ id: sandbox.id, name: sandbox.name, deleted: true }, null, 2));
      else output(`Deleted '${sandbox.name}' (${sandbox.id}).`);
    });

  program.command("run <id|name> <command...>")
    .description("Run a one-shot command in a running sandbox")
    .option("--env <name=value>", "Set an environment variable (repeatable)", (value, previous: string[]) => [...previous, value], [])
    .option("--timeout <seconds>", "Command timeout in seconds")
    .action(async (target: string, command: string[], options: { env: string[]; timeout?: string }) => {
      const sandbox = await resolveSandbox(requireService(), target);
      if (sandbox.status !== "running") throw new Error(`Cannot run a command in sandbox '${sandbox.name}' while it is ${sandbox.status}`);
      const runOptions = parseRunOptions(options);
      const result = await sandbox.exec(command.join(" "), {
        ...runOptions,
        collectOutput: false,
        onOutput: ({ stream, data }) => (stream === "stdout" ? stdout : stderr).write(data),
      });
      setExitCode(resultExitCode(result));
    });

  program.command("shell <id|name>")
    .description("Open an interactive shell in a running sandbox")
    .action(async (target: string) => {
      const sandbox = await resolveSandbox(requireService(), target);
      if (sandbox.status !== "running") throw new Error(`Cannot open a shell in sandbox '${sandbox.name}' while it is ${sandbox.status}`);
      const result = await runSandboxShell({ sandbox, stdin, stdout: stdout as NodeJS.WriteStream, stderr, signals });
      setExitCode(resultExitCode(result));
    });

  return program;
}
