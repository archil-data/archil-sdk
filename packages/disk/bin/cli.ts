#!/usr/bin/env node
import { protectApiKeyArgument } from "../src/cli/argv-secrets.js";
import { printError } from "../src/cli/ui.js";
import { createRequire } from "node:module";
import { Command } from "../src/cli/command.js";
import { addGlobalOptions, addProfileCommands } from "../src/cli/common.js";
import { addDiskCommands, rewriteDiskExecSugar } from "../src/cli/disk-command.js";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

protectApiKeyArgument(process.argv);

const program = new Command()
  .name("disk")
  .description("Manage Archil disks from the command line")
  .version(pkg.version);
addGlobalOptions(program);
addProfileCommands(program);
// The standalone `disk` executable keeps its original output for existing scripts.
addDiskCommands(program, program, { legacy: true });

program.parseAsync(rewriteDiskExecSugar(process.argv)).catch((err: unknown) => {
  printError(err, process.stderr, "disk", { legacy: true });
  process.exit(1);
});
