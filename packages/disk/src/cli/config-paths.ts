import { homedir } from "node:os";
import { join } from "node:path";

export function diskConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
): string {
  if (env.ARCHIL_DISK_CONFIG_DIR) return env.ARCHIL_DISK_CONFIG_DIR;
  if (platform === "win32") {
    return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "Archil", "disk");
  }
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "Archil", "disk");
  }
  return join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "archil", "disk");
}

export function profileConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(diskConfigDir(env), "config.json");
}

export function credentialFilePath(profile: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(diskConfigDir(env), "credentials", `${encodeURIComponent(profile)}.key`);
}
