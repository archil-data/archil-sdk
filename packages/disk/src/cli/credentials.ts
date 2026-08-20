import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { credentialFilePath } from "./config-paths.js";
import type { DiskProfile } from "./profiles.js";

export function normalizeApiKey(value: string): string {
  const normalized = value.trim().replace(/^key-/, "");
  if (!normalized) throw new Error("API key is empty");
  return normalized;
}

export async function readProfileCredential(
  profile: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const path = credentialFilePath(profile, env);
  try {
    if (process.platform !== "win32") {
      const mode = (await stat(path)).mode & 0o777;
      if ((mode & 0o077) !== 0) {
        throw new Error(`Refusing to read credential file ${path}: permissions must be 0600`);
      }
    }
    return normalizeApiKey(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Missing API key for profile '${profile}': run 'disk profile login --profile ${profile}'`);
    }
    throw error;
  }
}

export async function writeProfileCredential(
  profile: string,
  secret: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const path = credentialFilePath(profile, env);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`key-${normalizeApiKey(secret)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

export async function deleteProfileCredential(
  profile: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await rm(credentialFilePath(profile, env), { force: true });
}

export interface ResolveCredentialOptions {
  apiKey?: string;
  region?: string;
  baseUrl?: string;
  profile?: string;
}

export async function resolveCliCredentials(
  options: ResolveCredentialOptions,
  profiles: { currentProfile?: string; profiles: Record<string, DiskProfile> },
  env: NodeJS.ProcessEnv = process.env,
  readCredential: (profile: string, env: NodeJS.ProcessEnv) => Promise<string> = readProfileCredential,
): Promise<{ apiKey: string; region: string; baseUrl?: string; profile?: string }> {
  const selected = options.profile ?? env.ARCHIL_PROFILE ?? profiles.currentProfile;
  const profile = selected ? profiles.profiles[selected] : undefined;
  if (selected && !profile) throw new Error(`Profile '${selected}' does not exist`);
  const apiKey = options.apiKey ?? env.ARCHIL_API_KEY ?? (profile && selected ? await readCredential(selected, env) : undefined);
  const region = options.region ?? env.ARCHIL_REGION ?? profile?.region;
  const baseUrl = options.baseUrl ?? env.ARCHIL_BASE_URL ?? profile?.baseUrl;
  if (!apiKey) throw new Error("Missing API key: pass --api-key, set ARCHIL_API_KEY, or run 'disk profile login'");
  if (!region) throw new Error("Missing region: pass --region, set ARCHIL_REGION, or select a profile");
  return { apiKey: normalizeApiKey(apiKey), region, baseUrl, profile: selected };
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
    return normalizeApiKey(Buffer.concat(chunks).toString("utf8"));
  }
  output.write(prompt);
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode(wasRaw);
      input.pause();
      output.write("\n");
    };
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 3) {
          cleanup();
          reject(new Error("Login cancelled"));
          return;
        }
        if (byte === 13 || byte === 10) {
          cleanup();
          try { resolve(normalizeApiKey(value)); } catch (error) { reject(error); }
          return;
        }
        if (byte === 127 || byte === 8) value = value.slice(0, -1);
        else if (byte >= 32) value += String.fromCharCode(byte);
      }
    };
    input.on("data", onData);
  });
}
