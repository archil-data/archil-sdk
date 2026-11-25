#!/usr/bin/env node
import { printError } from "../src/cli/ui.js";
import { createRequire } from "node:module";
import { Archil } from "../src/index.js";
import { createSandboxProgram } from "../src/cli/sandbox-command.js";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

function fail(error: unknown): never {
  printError(error, process.stderr, "sandbox", { legacy: true });
  process.exit(1);
}

const program = createSandboxProgram({
  version: pkg.version,
  createClient: (options) => new Archil(options),
});

program.parseAsync(process.argv).catch(fail);
