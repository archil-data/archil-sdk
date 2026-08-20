#!/usr/bin/env node
import { createRequire } from "node:module";
import { Archil, ArchilApiError } from "../src/index.js";
import { createSandboxProgram } from "../src/cli/sandbox-command.js";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

function fail(error: unknown): never {
  if (error instanceof ArchilApiError) {
    console.error(`Error (${error.status}): ${error.message}`);
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exit(1);
}

const program = createSandboxProgram({
  version: pkg.version,
  createClient: (options) => new Archil(options),
});

program.parseAsync(process.argv).catch(fail);
