#!/usr/bin/env node
// Entry point for the `archil` command, which the `archil` package installs.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createArchilProgram, firstCommandIndex, forwardToNativeClient, isNativeCommand } from "../src/cli/archil-command.js";
import { rewriteDiskExecSugar } from "../src/cli/disk-command.js";
import { Archil, ArchilApiError } from "../src/index.js";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

function fail(error: unknown): never {
  if (error instanceof ArchilApiError) {
    console.error(`Error (${error.status}): ${error.message}`);
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
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
  const commandIndex = firstCommandIndex(args);
  const isDisk = commandIndex !== -1 && args[commandIndex] === "disk";
  await program.parseAsync(isDisk ? rewriteDiskExecSugar(argv, commandIndex + 3) : argv);
}

main(process.argv).catch(fail);
