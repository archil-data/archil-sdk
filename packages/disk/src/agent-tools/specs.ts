import { z } from "zod";
import type { GrepResult } from "../disk.js";
import type { FileSystem } from "../filesystem.js";
import { toSegments } from "../paths.js";

/** What the bound tools operate on: a {@link FileSystem} plus the presentation
 * bits the agent layer adds on top — a layout hint appended to each tool's
 * description, and the container path the disks mount at (so `run_bash`'s working
 * directory lines up with the paths the file tools use). */
export interface ToolContext {
  fs: FileSystem;
  layoutHint: string;
  execRoot: string;
}

/** Translate an agent-facing path to the filesystem key the {@link FileSystem}
 * methods take. Strips the container mount root (`/mnt` for a single disk,
 * `/mnt/archil` for a workspace) so a path copied from a `run_bash` command
 * resolves the same, drops the leading slash, and resolves `.`/`..`. For a
 * workspace the result's first segment is the disk name (which the workspace
 * routes on); for a single disk it is a plain disk key. */
function toKey(ctx: ToolContext, path: string): string {
  return toSegments(path, ctx.execRoot).join("/");
}

/** Build a {@link ToolContext} from any filesystem. A workspace is detected by
 * its `diskNames()` method (duck-typed so this layer needn't import the class);
 * its disks are top-level directories, whereas a single disk is rooted at `/`. */
export function buildContext(fs: FileSystem): ToolContext {
  const withNames = fs as { diskNames?: () => string[] };
  if (typeof withNames.diskNames === "function") {
    const names = withNames.diskNames();
    const dirs = names.map((n) => `/${n}/…`).join(", ");
    const example = names[0] ?? "data";
    return {
      fs,
      execRoot: "/mnt/archil",
      layoutHint:
        `Files live on these disks, each a top-level directory: ${dirs}. ` +
        `Use absolute paths like /${example}/reports/q1.csv.`,
    };
  }
  return {
    fs,
    execRoot: "/mnt",
    layoutHint: "Files live under / (the disk root). Use absolute paths like /reports/q1.csv.",
  };
}

/** Coerce a tool argument to a boolean. A model may send a JSON string instead
 * of a real boolean; mirror the Python handlers and parse common string forms
 * rather than rejecting the call. */
function asBool(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
  }
  return Boolean(value);
}

/** Coerce a tool argument to an integer. A model may send a JSON string ("200")
 * instead of a number; mirror the Python `_as_int` and parse it rather than
 * rejecting the call. Rejects booleans and anything non-numeric. */
function asInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return fallback;
}

/** A note warning the model when grep results may be partial — distinguishing a
 * truncated result (more matches exist) from a search that couldn't complete. */
function grepCaveat(result: GrepResult): string {
  switch (result.stoppedReason) {
    case "max_results":
      return `… more matches exist; showing the first ${result.matches.length}.`;
    case "deadline":
      return "… search hit the time limit; results may be incomplete.";
    case "incomplete":
      return "… some files could not be searched; results may be incomplete.";
    case "list_failed":
      return "… listing failed for part of the tree; results may be partial.";
    default:
      return "";
  }
}

/** Root a grep match path with a leading slash. A workspace already roots paths
 * by disk (`/data/...`); a single disk reports disk-relative keys (`reports/...`),
 * so prefix `/` to present both consistently. */
function rootMatchPath(file: string): string {
  return file.startsWith("/") ? file : `/${file}`;
}

// `recursive` accepts a boolean or a string boolean ("false"), coerced by
// asBool — models don't always send a real JSON boolean.
const recursiveFlag = z.union([z.boolean(), z.string()]).optional();

export interface ToolSpec {
  name: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  handler: (ctx: ToolContext, args: Record<string, unknown>) => Promise<string>;
}

export interface BoundTool {
  name: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  invoke: (args: Record<string, unknown>) => Promise<string>;
}

export interface AgentToolsOptions {
  /** Select a subset of tools by name. Defaults to all six. */
  tools?: string[];
}

// --- handlers --------------------------------------------------------------

async function readFile(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
  const path = args.path as string;
  const bytes = await ctx.fs.getObject(toKey(ctx, path));
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text || `${path} is empty.`;
  } catch {
    return `${path} is a binary file (${bytes.length} bytes) and cannot be shown as text.`;
  }
}

async function writeFile(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
  const path = args.path as string;
  const content = args.content as string;
  await ctx.fs.putObject(toKey(ctx, path), content);
  return `Wrote ${new TextEncoder().encode(content).length} bytes to ${path}.`;
}

async function deleteFile(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
  const path = args.path as string;
  await ctx.fs.deleteObject(toKey(ctx, path));
  return `Deleted ${path}.`;
}

async function listFiles(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
  const path = (args.path as string) || "/";
  const recursive = asBool(args.recursive, false);
  const dir = toKey(ctx, path);
  const result = await ctx.fs.listObjects(dir ? `${dir}/` : undefined, { recursive });
  const entries: string[] = [];
  for (const cp of result.commonPrefixes) entries.push(`dir   /${cp.replace(/\/+$/, "")}/`);
  for (const obj of result.objects) {
    entries.push(`file  /${obj.key}  (${obj.size} bytes)`);
  }
  entries.sort();
  // isTruncated here means part of the listing is missing — for a workspace, a
  // disk that failed the fan-out. Warn so the agent doesn't read it as complete.
  const caveat = result.isTruncated ? "… some files could not be listed; results may be incomplete." : "";
  if (entries.length === 0) {
    return caveat ? `${path}: ${caveat}` : `${path} is empty or does not exist.`;
  }
  return `Contents of ${path}:\n${entries.join("\n")}${caveat ? `\n${caveat}` : ""}`;
}

async function grep(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
  const pattern = args.pattern as string;
  const path = (args.path as string) || "/";
  const recursive = asBool(args.recursive, true);
  const maxResults = asInt(args.maxResults, 200);
  const result = await ctx.fs.grep({ pattern, directory: toKey(ctx, path), recursive, maxResults });
  const caveat = grepCaveat(result);
  if (result.matches.length === 0) {
    const msg = `No matches for /${pattern}/ under ${path} (${result.filesScanned} files scanned).`;
    return caveat ? `${msg} ${caveat}` : msg;
  }
  const lines = result.matches.map((m) => `${rootMatchPath(m.file)}:${m.line}: ${m.text}`);
  if (caveat) lines.push(caveat);
  return lines.join("\n");
}

async function runBash(ctx: ToolContext, args: Record<string, unknown>): Promise<string> {
  const command = args.command as string;
  // Run from the mount root so a shell-relative path matches what the file tools
  // see (the disks live under execRoot in the exec container).
  const result = await ctx.fs.exec(`cd ${ctx.execRoot} && ${command}`);
  const parts = [`exit code: ${result.exitCode}`];
  if (result.stdout) parts.push(`stdout:\n${result.stdout}`);
  if (result.stderr) parts.push(`stderr:\n${result.stderr}`);
  return parts.join("\n");
}

// --- specs -----------------------------------------------------------------

export const SPECS: ToolSpec[] = [
  {
    name: "read_file",
    description: "Read the contents of a text file and return them.",
    schema: z.object({ path: z.string().describe("Path to the file from the filesystem root, e.g. /reports/q1.csv.") }),
    handler: readFile,
  },
  {
    name: "write_file",
    description: "Create or overwrite a file with the given text content.",
    schema: z.object({
      path: z.string().describe("Path to the file from the filesystem root, e.g. /reports/q1.csv."),
      content: z.string().describe("Full contents to write."),
    }),
    handler: writeFile,
  },
  {
    name: "delete_file",
    description: "Delete a file. Succeeds even if the file does not exist.",
    schema: z.object({ path: z.string().describe("Path to the file from the filesystem root, e.g. /reports/q1.csv.") }),
    handler: deleteFile,
  },
  {
    name: "list_files",
    description:
      "List files and subdirectories. Omit 'path' to list from the root. " +
      "Set 'recursive' to list the whole subtree.",
    schema: z.object({
      path: z.string().optional().describe("Directory to list (optional)."),
      recursive: recursiveFlag.describe("List the full subtree."),
    }),
    handler: listFiles,
  },
  {
    name: "grep",
    description:
      "Search file contents for an extended regular expression and return " +
      "matching lines as path:line: text. Searches recursively by default.",
    schema: z.object({
      pattern: z.string().describe("Extended regex (grep -E)."),
      path: z.string().optional().describe("Directory to search (optional)."),
      recursive: recursiveFlag.describe("Search subdirectories (default true)."),
      maxResults: z
        .union([z.number().int(), z.string()])
        .optional()
        .describe("Cap on matches (default 200)."),
    }),
    handler: grep,
  },
  {
    name: "run_bash",
    description:
      "Run a bash command in an ephemeral sandbox with the filesystem mounted. " +
      "The working directory is the filesystem root, so paths match the other " +
      "tools. Returns the exit code, stdout, and stderr.",
    schema: z.object({ command: z.string().describe("The bash command to run.") }),
    handler: runBash,
  },
];

const SPEC_NAMES = SPECS.map((s) => s.name);

function formatError(error: unknown, args: Record<string, unknown>): string {
  // Duck-type the status rather than `instanceof ArchilS3Error` so the check
  // survives across module boundaries (bundlers can give each entry its own
  // copy of the error classes).
  const status = (error as { status?: number } | null)?.status;
  if (status === 404 && typeof args.path === "string") {
    return `Error: file not found: ${args.path}`;
  }
  if (error instanceof z.ZodError) return `Error: invalid arguments: ${error.message}`;
  return `Error: ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * Bind the specs (optionally a subset, by name) to a filesystem. The layout hint
 * is appended to each description so the model knows where files live, and
 * `invoke` returns expected failures as text rather than throwing.
 */
export function bindTools(fs: FileSystem, names?: string[]): BoundTool[] {
  let chosen = SPECS;
  if (names) {
    const unknown = names.filter((n) => !SPEC_NAMES.includes(n));
    if (unknown.length > 0) {
      throw new Error(`unknown tool(s) ${JSON.stringify(unknown)}; available: ${JSON.stringify(SPEC_NAMES)}`);
    }
    chosen = SPECS.filter((s) => names.includes(s.name));
  }
  const ctx = buildContext(fs);
  return chosen.map((spec) => ({
    name: spec.name,
    description: `${spec.description} ${ctx.layoutHint}`,
    schema: spec.schema,
    invoke: async (args: Record<string, unknown>) => {
      const input = args ?? {};
      try {
        const parsed = spec.schema.parse(input) as Record<string, unknown>;
        return await spec.handler(ctx, parsed);
      } catch (error) {
        return formatError(error, input);
      }
    },
  }));
}
