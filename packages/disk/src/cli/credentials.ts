import { mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { credentialFilePath, regionCredentialDir } from "./config-paths.js";
import { profileEndpoint, type DiskProfile } from "./profiles.js";

export function validateApiKey(value: string): string {
  const key = value.trim();
  if (!key) throw new Error("API key is empty");
  if (/\s/.test(key)) throw new Error("API key must not contain whitespace");
  return key;
}

export async function readProfileCredential(
  profile: string,
  env: NodeJS.ProcessEnv = process.env,
  region?: string,
): Promise<string> {
  const path = credentialFilePath(profile, env, region);
  try {
    if (process.platform !== "win32") {
      const mode = (await stat(path)).mode & 0o777;
      if ((mode & 0o077) !== 0) {
        throw new Error(`Refusing to read credential file ${path}: permissions must be 0600`);
      }
    }
    return validateApiKey(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (region !== undefined) {
        throw new Error(`Missing API key for profile '${profile}' in ${region}: sign in again with 'archil login --profile ${profile}'`);
      }
      throw new Error(`Missing API key for profile '${profile}': delete and recreate it with 'profile create --profile ${profile}'`);
    }
    throw error;
  }
}

export async function writeProfileCredential(
  profile: string,
  secret: string,
  env: NodeJS.ProcessEnv = process.env,
  region?: string,
): Promise<void> {
  const path = credentialFilePath(profile, env, region);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${validateApiKey(secret)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

/** Deletes every key saved for the profile, in all of its regions. */
export async function deleteProfileCredential(
  profile: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await rm(credentialFilePath(profile, env), { force: true });
  await rm(regionCredentialDir(profile, env), { recursive: true, force: true });
}

/** Deletes the profile's non-default region keys except those for `keep`. */
export async function pruneRegionCredentials(
  profile: string,
  keep: Iterable<string>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const kept = new Set([...keep].map((region) => `${encodeURIComponent(region)}.key`));
  let files: string[];
  try {
    files = await readdir(regionCredentialDir(profile, env));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await Promise.all(files.filter((file) => !kept.has(file)).map((file) =>
    rm(join(regionCredentialDir(profile, env), file), { force: true })));
}

/** Global credential options given on the command line; environment variables are read separately. */
export interface CredentialFlags {
  apiKey?: string;
  region?: string;
  baseUrl?: string;
  profile?: string;
}

/** `flag`: --api-key. `env`: ARCHIL_API_KEY. `profile`: a key saved in a profile. */
export type CredentialSource = "flag" | "env" | "profile";

export interface ResolvedCredentials {
  apiKey: string;
  region: string;
  baseUrl?: string;
  profile?: string;
  source: CredentialSource;
}

export type CredentialChoice = Pick<ResolvedCredentials, "source" | "profile" | "region">;
let lastChoice: CredentialChoice | undefined;

/** Records which credentials the running command uses, so an error can say where a rejected key came from. */
export function rememberCredentialChoice({ source, profile, region }: CredentialChoice): void {
  lastChoice = { source, profile, region };
}

export function lastCredentialChoice(): CredentialChoice | undefined {
  return lastChoice;
}

type CredentialReader = (profile: string, env: NodeJS.ProcessEnv, region?: string) => Promise<string>;

/**
 * Picks one source for the key and takes the region and base URL that belong
 * with it: --api-key, then --profile, then ARCHIL_API_KEY, then ARCHIL_PROFILE
 * or the current profile. A profile holds a key per region; --region (else
 * ARCHIL_REGION, else the profile's default) picks which one.
 */
export async function resolveCliCredentials(
  flags: CredentialFlags,
  profiles: { currentProfile?: string; profiles: Record<string, DiskProfile> },
  env: NodeJS.ProcessEnv = process.env,
  readCredential: CredentialReader = readProfileCredential,
): Promise<ResolvedCredentials> {
  const withRegion = (source: CredentialSource, apiKey: string, missingRegion: string): ResolvedCredentials => {
    const region = flags.region ?? (env.ARCHIL_REGION || undefined);
    if (!region) throw new Error(`Missing region: ${missingRegion}`);
    const baseUrl = flags.baseUrl ?? (env.ARCHIL_BASE_URL || undefined);
    return { apiKey: validateApiKey(apiKey), region, baseUrl, source };
  };

  const fromProfile = async (name: string): Promise<ResolvedCredentials> => {
    const profile = profiles.profiles[name];
    if (!profile) throw new Error(`Profile '${name}' does not exist`);
    const regionFromEnv = flags.region === undefined && Boolean(env.ARCHIL_REGION);
    const region = flags.region ?? (env.ARCHIL_REGION || profile.region);
    const endpoint = profileEndpoint(profile, region);
    if (!endpoint) {
      const chosenBy = regionFromEnv ? " (chosen by ARCHIL_REGION)" : "";
      throw new Error(profile.apiKeyId !== undefined
        ? `Profile '${name}' isn't signed in to ${region}${chosenBy}. Run 'archil login --region ${region}' to add it.`
        : `Profile '${name}' has no key for ${region}${chosenBy}. Add one with 'profile create --profile ${name} --region ${region}'.`);
    }
    const apiKey = await readCredential(name, env, region === profile.region ? undefined : region);
    return { apiKey: validateApiKey(apiKey), region, baseUrl: flags.baseUrl ?? endpoint.baseUrl, profile: name, source: "profile" };
  };

  if (flags.apiKey !== undefined) return withRegion("flag", flags.apiKey, "--api-key needs --region or ARCHIL_REGION");
  if (flags.profile !== undefined) return fromProfile(flags.profile);
  if (env.ARCHIL_API_KEY) return withRegion("env", env.ARCHIL_API_KEY, "ARCHIL_API_KEY needs ARCHIL_REGION or --region");
  const selected = env.ARCHIL_PROFILE || profiles.currentProfile;
  if (selected) return fromProfile(selected);
  throw new Error("Missing API key: pass --api-key, set ARCHIL_API_KEY, or run 'profile create'");
}

interface SecretInput extends AsyncIterable<string | Uint8Array> {
  isTTY?: boolean;
  isRaw: boolean;
  setRawMode(mode: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  off(event: "data", listener: (chunk: Buffer) => void): unknown;
}

interface SecretOutput {
  write(value: string): unknown;
}

export async function promptSecret(
  prompt = "API key: ",
  input: SecretInput = process.stdin,
  output: SecretOutput = process.stderr,
): Promise<string> {
  if (!input.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of input) chunks.push(Buffer.from(chunk));
    return validateApiKey(Buffer.concat(chunks).toString("utf8"));
  }
  return readMaskedLine(prompt, input, output);
}

/**
 * Read a line from a TTY in raw mode, echoing `*` per character. An invalid key
 * prints the reason and asks again; Ctrl-C cancels.
 */
function readMaskedLine(prompt: string, input: SecretInput, output: SecretOutput): Promise<string> {
  return new Promise((resolve, reject) => {
    const wasRaw = input.isRaw;
    let value = "";
    const finish = (settle: () => void) => {
      input.off("data", onData);
      input.setRawMode(wasRaw);
      input.pause();
      output.write("\n");
      settle();
    };
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\x03" || (char === "\x04" && value === "")) {
          finish(() => reject(new Error("Profile creation cancelled")));
          return;
        }
        if (char === "\r" || char === "\n") {
          try {
            const key = validateApiKey(value);
            finish(() => resolve(key));
            return;
          } catch (error) {
            output.write(`\n${error instanceof Error ? error.message : String(error)}\n${prompt}`);
            value = "";
          }
        } else if (char === "\x7f" || char === "\b") {
          if (value) {
            value = value.slice(0, -1);
            output.write("\b \b");
          }
        } else if (char >= " ") {
          value += char;
          output.write("*");
        }
      }
    };
    output.write(prompt);
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}
