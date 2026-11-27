#!/usr/bin/env node
import { protectApiKeyArgument } from "../src/cli/argv-secrets.js";
import { printError } from "../src/cli/ui.js";
import { createRequire } from "node:module";
import { Archil } from "../src/index.js";
import { createSandboxProgram } from "../src/cli/sandbox-command.js";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

function fail(error: unknown): never {
  printError(error, process.stderr, "sandbox", { legacy: true });
  process.exit(1);
}

protectApiKeyArgument(process.argv);

const program = createSandboxProgram({
  version: pkg.version,
  createClient: (options) => new Archil(options),
});

program.parseAsync(process.argv).catch(fail);
