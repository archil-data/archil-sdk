// `--api-key <key>` puts the key in the process's command line, which any other
// user on a Linux host can read from /proc/<pid>/cmdline (`ps -ef`) for as long
// as the CLI runs. We can't stop the kernel from exposing it between exec and
// startup, but once we're running we can overwrite the argv memory it reads
// from: on Linux, setting process.title rewrites that region in place and
// zero-fills the rest. ARCHIL_API_KEY, a profile, or `--api-key -` (read the key
// from stdin) keep it out of the command line entirely.

/** The value `--api-key` / `-k` takes to read the key from stdin instead. */
export const API_KEY_FROM_STDIN = "-";

const REDACTED = "***";

export const API_KEY_ARGV_WARNING =
  "warning: --api-key puts your API key in the process list, where other users on this machine can read it. " +
  "Use ARCHIL_API_KEY, a saved profile, or '--api-key -' to read it from stdin, and rotate keys you've passed this way.\n";

/**
 * A copy of `args` with every API key given on the command line replaced by
 * `***`, and whether there was one. Recognizes `--api-key <key>`,
 * `--api-key=<key>`, `-k <key>`, and `-k<key>` up to `--`, the same places the
 * CLI parser reads them from. `-` (stdin) isn't a secret and is left alone.
 */
export function redactApiKeyArgs(args: readonly string[]): { args: string[]; redacted: boolean } {
  const out = [...args];
  let redacted = false;
  const redact = (index: number, prefix = "") => {
    if (index >= out.length) return;
    if (out[index]!.slice(prefix.length) === API_KEY_FROM_STDIN) return;
    out[index] = `${prefix}${REDACTED}`;
    redacted = true;
  };
  for (let index = 0; index < out.length; index++) {
    const token = out[index]!;
    if (token === "--") break;
    if (token === "--api-key" || token === "-k") {
      redact(++index);
    } else if (token.startsWith("--api-key=")) {
      redact(index, "--api-key=");
    } else if (token.startsWith("-k") && !token.startsWith("--")) {
      redact(index, "-k");
    }
  }
  return { args: out, redacted };
}

export interface ProtectApiKeyOptions {
  /** Print a warning to stderr when a key was found. Default true. */
  warn?: boolean;
  setTitle?: (title: string) => void;
  stderr?: { write(value: string): unknown };
}

/**
 * Scrub an API key passed in `argv` (`process.argv`) from the process's visible
 * command line, and warn that it was exposed. Call it first thing in a CLI
 * entry point; `process.argv` itself is left intact for parsing.
 */
export function protectApiKeyArgument(argv: readonly string[] = process.argv, options: ProtectApiKeyOptions = {}): boolean {
  const { args, redacted } = redactApiKeyArgs(argv.slice(1));
  if (!redacted) return false;
  const setTitle = options.setTitle ?? ((title: string) => { process.title = title; });
  try {
    setTitle([process.argv0 || argv[0] || "node", ...args].join(" "));
  } catch {
    // Best effort: some platforms can't change the title.
  }
  if (options.warn ?? true) (options.stderr ?? process.stderr).write(API_KEY_ARGV_WARNING);
  return true;
}
