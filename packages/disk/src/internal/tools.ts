import { z, type ZodType } from "zod";
import type { GrepStoppedReason } from "../disk.js";
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

/** Root a grep match path with a leading slash. A workspace already roots paths
 * by disk (`/data/...`); a single disk reports disk-relative keys (`reports/...`),
 * so prefix `/` to present both consistently. */
function rootMatchPath(file: string): string {
  return file.startsWith("/") ? file : `/${file}`;
}

const DEFAULT_GLOB_LIMIT = 100;
const MAX_GLOB_LIMIT = 1000;
const MAX_GLOB_OUTPUT_BYTES = 50 * 1024;

function normalizeSearchPath(ctx: ToolContext, path: string): { key: string; path: string } {
  const key = toKey(ctx, path);
  return { key, path: rootMatchPath(key) };
}

function globLimit(limit: number | undefined): number {
  return Math.min(Math.max(1, limit ?? DEFAULT_GLOB_LIMIT), MAX_GLOB_LIMIT);
}

function isGitPath(path: string): boolean {
  return path.split("/").includes(".git");
}

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

function relativeToSearchPath(key: string, searchKey: string): string {
  if (!searchKey) return key;
  return key.slice(searchKey.length).replace(/^\/+/, "");
}

function globMatcher(pattern: string): (path: string) => boolean {
  const regexes = expandBraces(pattern).map((p) => globToRegExp(p));
  return (path) => regexes.some((regex) => regex.test(path));
}

function expandBraces(pattern: string): string[] {
  const start = pattern.indexOf("{");
  if (start < 0) return [pattern];
  const end = pattern.indexOf("}", start + 1);
  if (end < 0) return [pattern];
  const before = pattern.slice(0, start);
  const after = pattern.slice(end + 1);
  return pattern.slice(start + 1, end)
    .split(",")
    .flatMap((part) => expandBraces(`${before}${part}${after}`));
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        i += 1;
        if (pattern[i + 1] === "/") {
          i += 1;
          source += "(?:[^/]+/)*";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    if (char === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end > i + 1) {
        const raw = pattern.slice(i + 1, end);
        const negated = raw.startsWith("!");
        source += `[${negated ? "^" : ""}${escapeCharacterClass(negated ? raw.slice(1) : raw)}]`;
        i = end;
        continue;
      }
    }
    source += escapeRegExp(char);
  }
  return new RegExp(`${source}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function escapeCharacterClass(value: string): string {
  return value.replace(/[\\\]]/g, "\\$&");
}

function matchesGlob(pattern: string, key: string, searchKey: string, absolute: boolean): boolean {
  const matcher = globMatcher(pattern);
  if (absolute) return matcher(key);
  const relative = relativeToSearchPath(key, searchKey);
  if (pattern.includes("/")) {
    return matcher(relative) || matcher(key);
  }
  return matcher(basename(relative));
}

function formatGlobResult(paths: string[], limit: number, listingTruncated: boolean, path: string) {
  const limited = paths.slice(0, limit);
  const lines: string[] = [];
  let bytes = 0;
  let outputTruncated = false;
  for (const line of limited) {
    const lineBytes = new TextEncoder().encode(line).length + 1;
    if (bytes + lineBytes > MAX_GLOB_OUTPUT_BYTES && lines.length > 0) {
      outputTruncated = true;
      break;
    }
    lines.push(line);
    bytes += lineBytes;
  }
  if (lines.length === 0) {
    return { content: "No files found", count: 0, path, truncated: listingTruncated };
  }
  const truncated = listingTruncated || paths.length > limit || outputTruncated;
  const count = lines.length;
  if (truncated) {
    lines.push("");
    lines.push(`(Results truncated: showing first ${count} results out of more. Use a more specific path or pattern to narrow results.)`);
  }
  return { content: lines.join("\n"), count, path, truncated };
}

function grepStatus(reason: GrepStoppedReason, matches: number): string {
  switch (reason) {
    case "completed":
      return "Search completed.";
    case "max_results":
      return `More matches exist; returned ${matches}.`;
    case "deadline":
      return "Search hit the time limit; results may be incomplete.";
    case "incomplete":
      return "Some files could not be searched; results may be incomplete.";
    case "list_failed":
      return "Listing failed for part of the tree; results may be partial.";
  }
}

export interface ToolErrorResult {
  error: {
    message: string;
    status?: number;
    path?: string;
  };
}

interface Spec<N extends string, T extends ZodType, V = unknown> {
  name: N;
  description: string;
  schema: T;
  handler: (ctx: ToolContext, args: z.infer<T>) => Promise<V>;
}

type AnySpec = Spec<string, any, unknown>;

function defineSpec<N extends string, T extends ZodType, V>(spec: Spec<N, T, V>): Spec<N, T, V> {
  return spec;
}

// --- specs -----------------------------------------------------------------
const SPECS = [
  defineSpec({
    name: "read_file",
    description: "Read the contents of a text file and return them.",
    schema: z.object({ path: z.string().describe("Path to the file from the filesystem root, e.g. /reports/q1.csv.") }),
    async handler(ctx, args) {
      const path = args.path;
      const bytes = await ctx.fs.getObject(toKey(ctx, path));
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        return { content: text, bytes: bytes.length };
      } catch {
        return { binary: true as const, bytes: bytes.length };
      }
    },
  }),
  defineSpec({
    name: "write_file",
    description: "Create or overwrite a file with the given text content.",
    schema: z.object({
      path: z.string().describe("Path to the file from the filesystem root, e.g. /reports/q1.csv."),
      content: z.string().describe("Full contents to write."),
    }),
    async handler(ctx, args) {
      await ctx.fs.putObject(toKey(ctx, args.path), args.content);
      return { bytes: new TextEncoder().encode(args.content).length };
    },
  }),
  defineSpec({
    name: "delete_file",
    description: "Delete a file. Succeeds even if the file does not exist.",
    schema: z.object({ path: z.string().describe("Path to the file from the filesystem root, e.g. /reports/q1.csv.") }),
    async handler(ctx, args) {
      await ctx.fs.deleteObject(toKey(ctx, args.path));
      return {};
    },
  }),
  defineSpec({
    name: "list_files",
    description:
      "List files and subdirectories. Omit 'path' to list from the root. " +
      "Set 'recursive' to list the whole subtree.",
    schema: z.object({
      path: z.string().optional().describe("Directory to list (optional)."),
      recursive: z.boolean().optional().describe("List the full subtree."),
    }),
    async handler(ctx, args) {
      const path = args.path || "/";
      const recursive = args.recursive ?? false;
      const dir = toKey(ctx, path);
      const result = await ctx.fs.listObjects(dir ? `${dir}/` : undefined, { recursive });
      const entries = [
        ...result.commonPrefixes.map((cp) => ({ type: "dir" as const, path: `/${cp.replace(/\/+$/, "")}/` })),
        ...result.objects.map((obj) => ({ type: "file" as const, path: `/${obj.key}`, bytes: obj.size })),
      ];
      entries.sort((a, b) => a.path.localeCompare(b.path) || a.type.localeCompare(b.type));
      return result.isTruncated ? { entries, isTruncated: true as const } : { entries };
    },
  }),
  defineSpec({
    name: "glob",
    description:
      "Find files by glob pattern. Use this to look up filenames by pattern; " +
      "use grep to search file contents.",
    schema: z.object({
      pattern: z.string().describe('Glob pattern to match, e.g. "**/*.ts" or "src/**/*.js".'),
      path: z.string().optional().describe("Directory to search from (optional)."),
      limit: z.number().int().optional().describe("Maximum number of results to return (default 100, max 1000)."),
    }),
    async handler(ctx, args) {
      const search = normalizeSearchPath(ctx, args.path || "/");
      const absolutePattern = args.pattern.startsWith("/");
      const pattern = absolutePattern ? toKey(ctx, args.pattern) : args.pattern;
      const limit = globLimit(args.limit);
      const result = await ctx.fs.listObjects(search.key ? `${search.key}/` : undefined, { recursive: true });
      const paths = result.objects
        .map((obj) => obj.key)
        .filter((key) => !isGitPath(key) && matchesGlob(pattern, key, search.key, absolutePattern))
        .map(rootMatchPath)
        .sort();
      return formatGlobResult(paths, limit, result.isTruncated, search.path);
    },
  }),
  defineSpec({
    name: "grep",
    description:
      "Search file contents for an extended regular expression and return " +
      "matching lines as path:line: text. Searches recursively by default.",
    schema: z.object({
      pattern: z.string().describe("Extended regex (grep -E)."),
      path: z.string().optional().describe("Directory to search (optional)."),
      recursive: z.boolean().optional().describe("Search subdirectories (default true)."),
      maxResults: z.number().int().optional().describe("Cap on matches (default 200)."),
    }),
    async handler(ctx, args) {
      const path = args.path || "/";
      const recursive = args.recursive ?? true;
      const maxResults = args.maxResults ?? 200;
      const result = await ctx.fs.grep({ pattern: args.pattern, directory: toKey(ctx, path), recursive, maxResults });
      return {
        matches: result.matches.map((m) => ({ path: rootMatchPath(m.file), line: m.line, text: m.text })),
        status: grepStatus(result.stoppedReason, result.matches.length),
        filesScanned: result.filesScanned,
      };
    },
  }),
  defineSpec({
    name: "run_bash",
    description:
      "Run a bash command in an ephemeral sandbox with the filesystem mounted. " +
      "The working directory is the filesystem root, so paths match the other " +
      "tools. Returns the exit code, stdout, and stderr.",
    schema: z.object({ command: z.string().describe("The bash command to run.") }),
    async handler(ctx, args) {
      // Run from the mount root so a shell-relative path matches what the file
      // tools see (the disks live under execRoot in the exec container).
      const result = await ctx.fs.exec(`cd ${ctx.execRoot} && ${args.command}`);
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        timing: result.timing,
      };
    },
  }),
] as const;

export type ToolSpecs = typeof SPECS;

function formatError(error: unknown, args: Record<string, unknown>): ToolErrorResult {
  // Duck-type the status rather than `instanceof ArchilS3Error` so the check
  // survives across module boundaries (bundlers can give each entry its own
  // copy of the error classes).
  const status = (error as { status?: number } | null)?.status;
  if (status === 404 && typeof args.path === "string") {
    return { error: { message: "file not found", status, path: args.path } };
  }
  return { error: { message: error instanceof Error ? error.message : String(error) } };
}

export interface BoundSpec<N extends string, T extends ZodType, V> {
  name: N;
  description: string;
  schema: T;
  invoke: (args: z.infer<T>) => Promise<V | ToolErrorResult>;
}
export type AnyBoundSpec = BoundSpec<string, any, unknown>;

type BindSpec<T> = T extends Spec<infer N, infer S, infer V> ? BoundSpec<N, S, V> : never;

type BindSpecs<Specs extends readonly AnySpec[], Accumulator extends BindSpec<AnySpec>[]> = Specs extends readonly [infer Head extends AnySpec, ...infer Tail extends AnySpec[]]
  ? BindSpecs<Tail, [BindSpec<Head>, ...Accumulator]>
  : Accumulator;

export type BoundSpecs = BindSpecs<typeof SPECS, []>;
export type inferSpecInput<T> = T extends BoundSpec<any, infer S, any> ? z.infer<S> : never;
export type inferSpecResult<T> = T extends BoundSpec<any, any, infer V> ? V | ToolErrorResult : never;

/**
 * Bind the specs to a filesystem. The layout hint is appended to each
 * description so the model knows where files live, and `invoke` returns
 * expected failures as structured error objects rather than throwing.
 */
export function bindSpecs(fs: FileSystem): BoundSpecs {
  const ctx = buildContext(fs);
  return SPECS.map((spec) => ({
    name: spec.name,
    description: `${spec.description} ${ctx.layoutHint}`,
    schema: spec.schema,
    async invoke(args: any) {
      const input = args ?? {};
      try {
        return await spec.handler(ctx, input);
      } catch (error) {
        return formatError(error, input as Record<string, unknown>);
      }
    },
  })) as unknown as BoundSpecs;
}
