#!/usr/bin/env node
// Entry point for the `archil` command, which the `archil` package installs.
import { printError } from "../src/cli/ui.js";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createArchilProgram, firstCommandIndex, forwardToNativeClient, isNativeCommand } from "../src/cli/archil-command.js";
import { rewriteDiskExecSugar } from "../src/cli/disk-command.js";
import { cachedSandboxNames, completeWords, type CompletionSource } from "../src/cli/completion.js";
import { resolveCliCredentials } from "../src/cli/credentials.js";
import { loadProfiles } from "../src/cli/profiles.js";
import { Archil } from "../src/index.js";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

function fail(error: unknown): never {
  printError(error, process.stderr, "archil");
  process.exit(1);
}

async function main(argv: string[]): Promise<void> {
  const args = argv.slice(2);
  if (isNativeCommand(args)) {
    process.exitCode = await forwardToNativeClient(args, process.env, process.argv[1] ?? fileURLToPath(import.meta.url));
    return;
  }
  const program = createArchilProgram({
    version: pkg.version,
    createClient: (options) => new Archil(options),
  });
  if (args[0] === "__complete") {
    const candidates = await completeWords(program, args.slice(1), completionLookup).catch(() => []);
    if (candidates.length > 0) process.stdout.write(`${candidates.join("\n")}\n`);
    return;
  }
  const commandIndex = firstCommandIndex(args);
  const isDisk = commandIndex !== -1 && args[commandIndex] === "disk";
  await program.parseAsync(isDisk ? rewriteDiskExecSugar(argv, commandIndex + 3) : argv);
}

async function completionLookup(source: CompletionSource): Promise<string[]> {
  const profiles = await loadProfiles();
  if (source === "profiles") return Object.keys(profiles.profiles);
  return cachedSandboxNames(async () => {
    const client = new Archil(await resolveCliCredentials({}, profiles));
    const listing = client.sandboxes.list();
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), 3000).unref());
    return (await Promise.race([listing, timeout])).map((sandbox) => sandbox.name);
  });
}

main(process.argv).catch(fail);
