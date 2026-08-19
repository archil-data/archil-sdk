import { chmod, mkdir, open, readFile, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { profileConfigPath } from "./config-paths.js";

export interface DiskProfile {
  region: string;
  baseUrl?: string;
}

export interface ProfileConfig {
  version: 1;
  currentProfile?: string;
  profiles: Record<string, DiskProfile>;
}

export const EMPTY_PROFILE_CONFIG: ProfileConfig = { version: 1, profiles: {} };

function parseConfig(value: unknown): ProfileConfig {
  if (!value || typeof value !== "object") throw new Error("Profile configuration must be a JSON object");
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) throw new Error(`Unsupported profile configuration version: ${String(raw.version)}`);
  if (!raw.profiles || typeof raw.profiles !== "object" || Array.isArray(raw.profiles)) {
    throw new Error("Profile configuration has an invalid profiles field");
  }
  for (const [name, profile] of Object.entries(raw.profiles as Record<string, unknown>)) {
    if (!profile || typeof profile !== "object") throw new Error(`Profile '${name}' is invalid`);
    const p = profile as Record<string, unknown>;
    if (typeof p.region !== "string" || !p.region) throw new Error(`Profile '${name}' has no region`);
  }
  if (raw.currentProfile !== undefined && typeof raw.currentProfile !== "string") {
    throw new Error("Profile configuration has an invalid currentProfile field");
  }
  return value as ProfileConfig;
}

export async function loadProfiles(env: NodeJS.ProcessEnv = process.env): Promise<ProfileConfig> {
  const path = profileConfigPath(env);
  try {
    return parseConfig(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY_PROFILE_CONFIG, profiles: {} };
    if (error instanceof SyntaxError) throw new Error(`Malformed profile configuration at ${path}`);
    throw error;
  }
}

export async function saveProfiles(config: ProfileConfig, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const path = profileConfigPath(env);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  if (process.platform !== "win32") {
    const mode = (await stat(path)).mode & 0o777;
    if (mode !== 0o600) await chmod(path, 0o600);
  }
}

export async function deleteProfile(name: string, env: NodeJS.ProcessEnv = process.env): Promise<DiskProfile | undefined> {
  const config = await loadProfiles(env);
  const profile = config.profiles[name];
  if (!profile) return undefined;
  delete config.profiles[name];
  if (config.currentProfile === name) config.currentProfile = undefined;
  await saveProfiles(config, env);
  return profile;
}
