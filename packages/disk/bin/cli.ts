#!/usr/bin/env node
import { printError } from "../src/cli/ui.js";
import { createRequire } from "node:module";
import { Command } from "../src/cli/command.js";
import { addGlobalOptions, addProfileCommands } from "../src/cli/common.js";
import { addDiskCommands, rewriteDiskExecSugar } from "../src/cli/disk-command.js";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

const program = new Command()
  .name("disk")
  .description("Manage Archil disks from the command line")
  .version(pkg.version);
addGlobalOptions(program);
addProfileCommands(program);
addDiskCommands(program, program);

program.parseAsync(rewriteDiskExecSugar(process.argv)).catch((err: unknown) => {
  printError(err, process.stderr, "disk");
  process.exit(1);
});
