#!/usr/bin/env node
import { createRequire } from "node:module";
import { Command, Option } from "commander";
import {
  ArchilApiError,
  configure,
  createApiKey,
  createDisk,
  deleteApiKey,
  getDisk,
  listApiKeys,
  listDisks,
} from "../src/index.js";
import type { CreateDiskRequest, MountResponse, AuthorizedUser, ConnectedClient } from "../src/types.js";
import type { Disk } from "../src/disk.js";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

const program = new Command();

program
  .name("disk")
  .description("Manage Archil disks from the command line")
  .version(pkg.version)
  .addOption(new Option("-k, --api-key <key>", "Archil API key").env("ARCHIL_API_KEY"))
  .addOption(new Option("-r, --region <region>", "Archil region").env("ARCHIL_REGION"))
  .addOption(new Option("--base-url <url>", "Override control-plane base URL"))
  .hook("preAction", () => {
    const opts = program.opts<{ apiKey?: string; region?: string; baseUrl?: string }>();
    try {
      configure({ apiKey: opts.apiKey, region: opts.region, baseUrl: opts.baseUrl });
    } catch (err) {
      fail(err);
    }
  });

function fail(err: unknown): never {
  if (err instanceof ArchilApiError) {
    console.error(`Error (${err.status}): ${err.message}`);
  } else {
    console.error(err instanceof Error ? err.message : String(err));
  }
  process.exit(1);
}

function isDiskId(s: string): boolean {
  return /^(dsk-|fs-)[0-9a-fA-F]+$/.test(s);
}

async function resolveDisk(idOrName: string): Promise<Disk> {
  if (isDiskId(idOrName)) {
    return getDisk(idOrName);
  }
  const matches = await listDisks({ name: idOrName });
  if (matches.length === 0) {
    throw new ArchilApiError(`No disk found with name '${idOrName}'`, 404);
  }
  if (matches.length > 1) {
    throw new ArchilApiError(
      `Multiple disks match name '${idOrName}' — pass a disk id (dsk-...) instead`,
      400,
    );
  }
  return matches[0];
}

function formatBytes(n: number | undefined): string | undefined {
  if (n === undefined || n === null) return undefined;
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

function renderTable(rows: string[][], headers?: string[]): string {
  const all = headers ? [headers, ...rows] : rows;
  if (all.length === 0) return "";
  const cols = Math.max(...all.map((r) => r.length));
  const widths: number[] = [];
  for (let i = 0; i < cols; i++) {
    widths[i] = Math.max(...all.map((r) => (r[i] ?? "").length));
  }
  const bar = (l: string, m: string, r: string): string =>
    l + widths.map((w) => "─".repeat(w + 2)).join(m) + r;
  const line = (r: string[]): string =>
    "│ " + widths.map((w, i) => (r[i] ?? "").padEnd(w)).join(" │ ") + " │";
  const out: string[] = [bar("╭", "┬", "╮")];
  if (headers) {
    out.push(line(headers));
    out.push(bar("├", "┼", "┤"));
  }
  for (const r of rows) out.push(line(r));
  out.push(bar("╰", "┴", "╯"));
  return out.join("\n");
}

function section(title: string, body: string): void {
  console.log("");
  console.log(title);
  console.log(body);
}

function printDisk(d: Disk): void {
  console.log(`${d.organization}/${d.name}  (${d.id})`);

  const kv: Array<[string, string | undefined]> = [
    ["status", d.status],
    ["provider", d.provider],
    ["region", d.region],
    ["created", d.createdAt],
    ["last accessed", d.lastAccessed],
    ["data size", formatBytes(d.dataSize)],
    ["monthly usage", d.monthlyUsage],
  ];
  const visible = kv
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => [k, String(v)]);
  console.log("");
  console.log(renderTable(visible));

  if (d.mounts && d.mounts.length > 0) {
    const rows = (d.mounts as MountResponse[]).map((m) => [
      m.type ?? "?",
      m.name ?? m.path ?? "",
      m.accessMode ?? "",
    ]);
    section("Mounts", renderTable(rows, ["type", "location", "mode"]));
  }

  if (d.authorizedUsers && d.authorizedUsers.length > 0) {
    const rows = (d.authorizedUsers as AuthorizedUser[]).map((u) => {
      if (u.type === "token") {
        return ["token", u.nickname ?? "(no name)", u.tokenSuffix ? `-${u.tokenSuffix}` : ""];
      }
      return [u.type ?? "?", u.identifier ?? u.principal ?? "", ""];
    });
    section("Authorized users", renderTable(rows, ["type", "name / identifier", "suffix"]));
  }

  if (d.connectedClients && d.connectedClients.length > 0) {
    const rows = (d.connectedClients as ConnectedClient[]).map((c) => [
      c.id ?? "",
      c.ipAddress ?? "",
      c.connectedAt ?? "",
    ]);
    section("Connected clients", renderTable(rows, ["id", "ip", "connected at"]));
  }
}

program
  .command("list")
  .description("List disks in the current region")
  .option("--limit <n>", "Maximum number of disks to return", (v) => parseInt(v, 10))
  .option("-o, --output <format>", "Output format: table | json", "table")
  .action(async (opts: { limit?: number; output: string }) => {
    try {
      const disks = await listDisks({ limit: opts.limit });
      if (opts.output === "json") {
        console.log(JSON.stringify(disks, null, 2));
        return;
      }
      if (disks.length === 0) {
        console.log("No disks found.");
        return;
      }
      const rows = disks.map((d) => [d.id, `${d.organization}/${d.name}`, d.status]);
      console.log(renderTable(rows, ["id", "name", "status"]));
    } catch (err) {
      fail(err);
    }
  });

program
  .command("get <id|name>")
  .description("Show details for a disk (accepts a disk id or name)")
  .option("-o, --output <format>", "Output format: table | json", "table")
  .action(async (idOrName: string, opts: { output: string }) => {
    try {
      const d = await resolveDisk(idOrName);
      if (opts.output === "json") {
        console.log(JSON.stringify(d, null, 2));
      } else {
        printDisk(d);
      }
    } catch (err) {
      fail(err);
    }
  });

program
  .command("create <name>")
  .description("Create a new disk")
  .action(async (name: string) => {
    try {
      const result = await createDisk({ name } as CreateDiskRequest);
      console.log(`Created disk ${result.disk.organization}/${result.disk.name}`);
      console.log(`  id:     ${result.disk.id}`);
      console.log(`  status: ${result.disk.status}`);
      if (result.token) {
        console.log("");
        console.log("Disk token (save this — it cannot be retrieved again):");
        console.log(`  ${result.token}`);
        if (result.tokenIdentifier) {
          console.log(`  identifier: ${result.tokenIdentifier}`);
        }
      }
    } catch (err) {
      fail(err);
    }
  });

program
  .command("delete <id|name>")
  .description("Delete a disk (accepts a disk id or name)")
  .action(async (idOrName: string) => {
    try {
      const d = await resolveDisk(idOrName);
      await d.delete();
      console.log(`Deleted ${d.organization}/${d.name} (${d.id})`);
    } catch (err) {
      fail(err);
    }
  });

program
  .command("exec <id|name> <command...>")
  .description("Run a command in a container with the disk mounted, return stdout/stderr/exit code (accepts a disk id or name)")
  .action(async (idOrName: string, cmd: string[]) => {
    try {
      const d = await resolveDisk(idOrName);
      const result = await d.exec(cmd.join(" "));
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode);
    } catch (err) {
      fail(err);
    }
  });

program
  .command("grep <pattern> <target>")
  .description(
    "Constant-time parallel server-side grep across a disk. <target> is " +
      "<id|name>[/<path>] — the path after the first '/' is the directory to " +
      "search (defaults to the disk root). Accepts a disk id or name.",
  )
  .option("--no-recursive", "Search only the given directory, not its subdirectories (recursive is the default)")
  .option("--max-duration <seconds>", "Wall-clock deadline for the whole search", (v) => parseInt(v, 10))
  .option("--concurrency <n>", "Max parallel grep workers (clamped to fleet capacity)", (v) => parseInt(v, 10))
  .option("--max-results <n>", "Stop once this many matches are collected", (v) => parseInt(v, 10))
  .option("-o, --output <format>", "Output format: text | json", "text")
  .action(
    async (
      pattern: string,
      target: string,
      opts: {
        recursive?: boolean;
        maxDuration?: number;
        concurrency?: number;
        maxResults?: number;
        output: string;
      },
    ) => {
      try {
        const slash = target.indexOf("/");
        const idOrName = slash === -1 ? target : target.slice(0, slash);
        const directory = slash === -1 ? "" : target.slice(slash + 1);
        const d = await resolveDisk(idOrName);
        const res = await d.grep({
          directory,
          pattern,
          recursive: opts.recursive !== false,
          maxDurationSeconds: opts.maxDuration,
          concurrency: opts.concurrency,
          maxResults: opts.maxResults,
        });
        if (opts.output === "json") {
          console.log(JSON.stringify(res, null, 2));
        } else {
          for (const m of res.matches) {
            console.log(`${m.file}:${m.line}:${m.text}`);
          }
          // grep-style: matches on stdout, run summary on stderr.
          console.error(
            `${res.matches.length} match${res.matches.length === 1 ? "" : "es"} · ` +
              `${res.filesScanned} files scanned · ${res.containersDispatched} containers · ` +
              `${res.durationMs}ms · ${res.stoppedReason}`,
          );
          if (res.stoppedReason !== "completed") {
            console.error(
              `warning: search did not complete (${res.stoppedReason}); results may be partial`,
            );
          }
        }
        // grep exit-code convention: 0 = matches found, 1 = none.
        process.exit(res.matches.length > 0 ? 0 : 1);
      } catch (err) {
        fail(err);
      }
    },
  );

const keys = program.command("api-keys").description("Manage Archil API keys (account-level credentials)");

keys
  .command("list")
  .description("List API keys")
  .option("--limit <n>", "Maximum number of keys to return", (v) => parseInt(v, 10))
  .action(async (opts: { limit?: number }) => {
    try {
      const ks = await listApiKeys({ limit: opts.limit });
      if (ks.length === 0) {
        console.log("No API keys found.");
        return;
      }
      for (const k of ks) {
        console.log(`${k.id ?? "-"}\t${k.name ?? "-"}\t${k.createdAt ?? ""}`);
      }
    } catch (err) {
      fail(err);
    }
  });

keys
  .command("create <name>")
  .description("Create a new API key (the key value is shown once)")
  .option("--description <description>", "Optional description")
  .action(async (name: string, opts: { description?: string }) => {
    try {
      const k = await createApiKey({ name, description: opts.description });
      console.log(`Created API key ${name} (${k.id ?? "?"})`);
      if (k.token) {
        console.log("");
        console.log("API key value (save this — it cannot be retrieved again):");
        console.log(`  ${k.token}`);
      }
    } catch (err) {
      fail(err);
    }
  });

keys
  .command("delete <id>")
  .description("Delete an API key")
  .action(async (id: string) => {
    try {
      await deleteApiKey(id);
      console.log(`Deleted API key ${id}`);
    } catch (err) {
      fail(err);
    }
  });

// Support `disk <id> exec <cmd...>` as a sugar form for `disk exec <id> <cmd...>`.
function rewriteSugar(argv: string[]): string[] {
  const known = new Set(["list", "get", "create", "delete", "exec", "grep", "api-keys", "help", "--help", "-h", "--version", "-V"]);
  const head = argv[2];
  const next = argv[3];
  if (head && next === "exec" && !known.has(head) && !head.startsWith("-")) {
    return [...argv.slice(0, 2), "exec", head, ...argv.slice(4)];
  }
  return argv;
}

program.parseAsync(rewriteSugar(process.argv));
