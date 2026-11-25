#!/usr/bin/env node
import { createRequire } from "node:module";
import { Command } from "../src/cli/command.js";
import { addGlobalOptions, addProfileCommands } from "../src/cli/common.js";
import { addDiskCommands, rewriteDiskExecSugar } from "../src/cli/disk-command.js";
import { ArchilApiError } from "../src/index.js";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

const program = new Command()
  .name("disk")
  .description("Manage Archil disks from the command line")
  .version(pkg.version);
addGlobalOptions(program);
addProfileCommands(program);
addDiskCommands(program, program);

program.parseAsync(rewriteDiskExecSugar(process.argv)).catch((err: unknown) => {
  if (err instanceof ArchilApiError) {
    console.error(`Error (${err.status}): ${err.message}`);
  } else {
    console.error(err instanceof Error ? err.message : String(err));
  }
  process.exit(1);
});
