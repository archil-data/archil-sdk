#!/usr/bin/env node
// Entry point for the `archil` command, which the `archil` package installs.
import { protectApiKeyArgument } from "../src/cli/argv-secrets.js";
import { printError } from "../src/cli/ui.js";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createArchilProgram, firstCommandIndex, forwardToNativeClient, isNativeCommand } from "../src/cli/archil-command.js";
import { rewriteDiskExecSugar } from "../src/cli/disk-command.js";
import { createHash } from "node:crypto";
import {
  cachedSandboxNames,
  completeWords,
  credentialOptions,
  type CompletionCredentials,
  type CompletionSource,
} from "../src/cli/completion.js";
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
  // Tab completion re-sends the typed line; scrub it there too, but quietly.
  protectApiKeyArgument(argv, { warn: args[0] !== "__complete" });
  if (isNativeCommand(args)) {
    process.exitCode = await forwardToNativeClient(args, process.env, process.argv[1] ?? fileURLToPath(import.meta.url));
    return;
  }
  const program = createArchilProgram({
    version: pkg.version,
    createClient: (options) => new Archil(options),
  });
  if (args[0] === "__complete") {
    const words = args.slice(1);
    const credentials = credentialOptions(words);
    const candidates = await completeWords(program, words, (source) => completionLookup(source, credentials)).catch(() => []);
    // A sandbox lookup that timed out may still hold the event loop; tab completion
    // must not wait on it, but must not cut off its own output either.
    process.stdout.write(candidates.length > 0 ? `${candidates.join("\n")}\n` : "", () => process.exit(0));
    return;
  }
  const commandIndex = firstCommandIndex(args);
  const isDisk = commandIndex !== -1 && args[commandIndex] === "disk";
  await program.parseAsync(isDisk ? rewriteDiskExecSugar(argv, commandIndex + 3) : argv);
}

async function completionLookup(source: CompletionSource, options: CompletionCredentials): Promise<string[]> {
  const profiles = await loadProfiles();
  if (source === "profiles") return Object.keys(profiles.profiles);
  const credentials = await resolveCliCredentials(options, profiles);
  const account = createHash("sha256")
    .update([credentials.apiKey, credentials.region, credentials.baseUrl ?? ""].join("\n"))
    .digest("hex");
  return cachedSandboxNames(account, async () => {
    const listing = new Archil(credentials).sandboxes.list();
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), 3000).unref());
    return (await Promise.race([listing, timeout])).map((sandbox) => sandbox.name);
  });
}

main(process.argv).catch(fail);
