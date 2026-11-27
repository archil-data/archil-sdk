// Child process for argv-secrets.test.ts: scrub argv like a CLI entry point
// does, then print what other users would see in /proc/<pid>/cmdline.
import { readFileSync } from "node:fs";
import { protectApiKeyArgument } from "../../src/cli/argv-secrets.ts";

protectApiKeyArgument(process.argv);
process.stdout.write(readFileSync("/proc/self/cmdline"));
