// Shell completion for `archil`. The shell scripts only forward the words on
// the command line to `archil __complete`; this module walks the command tree
// to suggest subcommands, options, option values, and sandbox names.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Command, Option } from "./command.js";
import { diskConfigDir } from "./config-paths.js";

export type CompletionSource = "sandboxes" | "profiles";
export type CompletionLookup = (source: CompletionSource) => Promise<string[]>;

/** Mount commands the native client handles; suggested at the top level. */
const NATIVE_COMMANDS = ["mount", "unmount", "status"];
const SANDBOX_NAME_CACHE_MS = 15_000;

function findOption(chain: Command[], word: string): Option | undefined {
  const long = word.startsWith("--") ? word.slice(2).split("=")[0] : undefined;
  for (const command of [...chain].reverse()) {
    const option = command.optionList().find((candidate) =>
      long !== undefined ? candidate.long === long : candidate.short === word.slice(1));
    if (option) return option;
  }
  return undefined;
}

/**
 * Candidates for the last word in `words` (everything after the program name;
 * the last entry is the partial word being completed, possibly empty).
 */
export async function completeWords(root: Command, words: string[], lookup: CompletionLookup): Promise<string[]> {
  const chain = [root];
  const operands: string[] = [];
  const done = words.slice(0, -1);
  const current = words.at(-1) ?? "";
  let pendingOption: Option | undefined;
  let afterSeparator = false;

  for (const word of done) {
    if (pendingOption) {
      pendingOption = undefined;
      continue;
    }
    if (afterSeparator) {
      operands.push(word);
      continue;
    }
    if (word === "--") {
      afterSeparator = true;
      continue;
    }
    if (word.startsWith("-") && word.length > 1) {
      const option = findOption(chain, word);
      if (option?.takesValue && !word.includes("=")) pendingOption = option;
      continue;
    }
    const command = chain.at(-1)!;
    const subcommand = operands.length === 0 ? command.commands.find((candidate) => candidate.name() === word) : undefined;
    if (subcommand) chain.push(subcommand);
    else operands.push(word);
  }

  const command = chain.at(-1)!;
  const matching = (candidates: string[]) => candidates.filter((candidate) => candidate.startsWith(current)).sort();

  if (pendingOption) {
    if (pendingOption.long === "output") return matching(["table", "json"]);
    if (pendingOption.long === "profile") return matching(await lookup("profiles"));
    return [];
  }
  if (!afterSeparator && current.startsWith("-")) {
    const options = chain.flatMap((owner) => owner.optionList()).map((option) => `--${option.long}`);
    return matching([...new Set([...options, "--help"])]);
  }
  if (!afterSeparator && command.commands.length > 0 && operands.length === 0) {
    const names = command.commands.map((candidate) => candidate.name()).filter((name) => !name.startsWith("__") && name !== "ssh-proxy");
    return matching([...names, ...(command === root ? NATIVE_COMMANDS : [])]);
  }
  const argument = command.argumentList()[operands.length] ?? command.argumentList().at(-1);
  const insideSandbox = chain.some((owner) => owner.name() === "sandbox");
  if (argument?.name === "id|name" && insideSandbox && operands.length === 0) {
    return matching(await lookup("sandboxes"));
  }
  return [];
}

export interface CompletionCredentials {
  apiKey?: string;
  region?: string;
  baseUrl?: string;
  profile?: string;
}

const GLOBAL_OPTION_NAMES: Record<string, keyof CompletionCredentials> = {
  "-k": "apiKey",
  "--api-key": "apiKey",
  "-r": "region",
  "--region": "region",
  "--base-url": "baseUrl",
  "--profile": "profile",
};

/** Global credential options typed on the command line being completed, so lookups use the same account. */
export function credentialOptions(words: string[]): CompletionCredentials {
  const options: CompletionCredentials = {};
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!;
    if (word === "--") break;
    const [flag, inline] = word.includes("=") ? [word.slice(0, word.indexOf("=")), word.slice(word.indexOf("=") + 1)] : [word, undefined];
    const key = GLOBAL_OPTION_NAMES[flag!];
    if (!key) continue;
    const value = inline ?? words[index + 1];
    if (inline === undefined) index++;
    if (value) options[key] = value;
  }
  return options;
}

/**
 * Sandbox names for completion, cached briefly so repeated tabs don't hit the
 * API. The cache is keyed by account (`cacheKey`) so switching profiles never
 * suggests another account's sandboxes.
 */
export async function cachedSandboxNames(cacheKey: string, list: () => Promise<string[]>, now = Date.now()): Promise<string[]> {
  const path = join(diskConfigDir(), "completion-cache.json");
  try {
    const cached = JSON.parse(await readFile(path, "utf8")) as { key: string; at: number; sandboxes: string[] };
    if (cached.key === cacheKey && now - cached.at < SANDBOX_NAME_CACHE_MS) return cached.sandboxes;
  } catch {
    // No usable cache.
  }
  const sandboxes = [...new Set(await list())];
  await mkdir(diskConfigDir(), { recursive: true }).catch(() => {});
  await writeFile(path, JSON.stringify({ key: cacheKey, at: now, sandboxes }), { mode: 0o600 }).catch(() => {});
  return sandboxes;
}

export function completionScript(shell: string, name = "archil"): string {
  switch (shell) {
    case "bash":
      return `# ${name} completion for bash. Add to ~/.bashrc:  source <(${name} completion bash)
_${name}_complete() {
  local IFS=$'\\n'
  COMPREPLY=($(${name} __complete "\${COMP_WORDS[@]:1:$COMP_CWORD}" 2>/dev/null))
}
complete -o default -F _${name}_complete ${name}
`;
    case "zsh":
      return `#compdef ${name}
# ${name} completion for zsh. Add to ~/.zshrc:  source <(${name} completion zsh)
_${name}() {
  local -a candidates
  candidates=("\${(@f)$(${name} __complete "\${(@)words[2,CURRENT]}" 2>/dev/null)}")
  compadd -- \${candidates:#}
}
if [ "$funcstack[1]" = "_${name}" ]; then _${name} "$@"; else compdef _${name} ${name}; fi
`;
    case "fish":
      return `# ${name} completion for fish. Save to ~/.config/fish/completions/${name}.fish
complete -c ${name} -f -a '(${name} __complete (commandline -opc)[2..-1] (commandline -ct))'
`;
    default:
      throw new Error(`Unsupported shell '${shell}'; use bash, zsh, or fish`);
  }
}
