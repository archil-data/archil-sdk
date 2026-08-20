import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { credentialFilePath, diskConfigDir, profileConfigPath } from "../src/cli/config-paths.js";
import {
  deleteProfileCredential,
  normalizeApiKey,
  promptSecret,
  readProfileCredential,
  resolveCliCredentials,
  writeProfileCredential,
} from "../src/cli/credentials.js";
import { loadProfiles, saveProfiles, type ProfileConfig } from "../src/cli/profiles.js";

const directories: string[] = [];
async function temporaryEnv() {
  const directory = await mkdtemp(join(tmpdir(), "disk-profile-test-"));
  directories.push(directory);
  return { ARCHIL_DISK_CONFIG_DIR: directory };
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("platform profile paths respect native conventions and override", () => {
  assert.equal(diskConfigDir({ XDG_CONFIG_HOME: "/xdg" }, "linux", "/home/me"), "/xdg/archil/disk");
  assert.equal(diskConfigDir({}, "linux", "/home/me"), "/home/me/.config/archil/disk");
  assert.equal(diskConfigDir({}, "darwin", "/Users/me"), "/Users/me/Library/Application Support/Archil/disk");
  assert.equal(diskConfigDir({ APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, "win32", "C:\\Users\\me"), "C:\\Users\\me\\AppData\\Roaming/Archil/disk");
  assert.equal(diskConfigDir({ ARCHIL_DISK_CONFIG_DIR: "/controlled" }), "/controlled");
});

test("profile files handle missing, malformed, versioned, atomic and protected writes", async () => {
  const env = await temporaryEnv();
  assert.deepEqual(await loadProfiles(env), { version: 1, profiles: {} });
  const config: ProfileConfig = {
    version: 1,
    currentProfile: "test",
    profiles: { test: { region: "aws-us-east-1" } },
  };
  await saveProfiles(config, env);
  assert.deepEqual(await loadProfiles(env), config);
  assert.equal((await stat(profileConfigPath(env))).mode & 0o777, 0o600);
  assert.equal((await readFile(profileConfigPath(env), "utf8")).includes("API-SECRET"), false);
  await writeFile(profileConfigPath(env), "not-json");
  await assert.rejects(loadProfiles(env), /Malformed profile configuration/);
  await writeFile(profileConfigPath(env), JSON.stringify({ version: 2, profiles: {} }));
  await assert.rejects(loadProfiles(env), /Unsupported profile configuration version/);
});

test("profile credentials always use protected files and reject unsafe permissions", async () => {
  const env = await temporaryEnv();
  const path = credentialFilePath("test", env);
  await writeProfileCredential("test", " key-secret \n", env);
  assert.equal(await readFile(path, "utf8"), "key-secret\n");
  assert.equal(await readProfileCredential("test", env), "secret");
  if (process.platform !== "win32") {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await chmod(path, 0o644);
    await assert.rejects(readProfileCredential("test", env), /permissions must be 0600/);
  }
  await deleteProfileCredential("test", env);
  await assert.rejects(readFile(path), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  await assert.rejects(readProfileCredential("test", env), /Missing API key for profile 'test'.*auth login/);
  assert.equal(normalizeApiKey("key-one"), "one");
  assert.equal(normalizeApiKey("two"), "two");
  assert.throws(() => normalizeApiKey("key-"), /empty/);
});

test("TTY secret prompt restores raw mode and always pauses stdin", async () => {
  class TestInput extends EventEmitter {
    isTTY = true;
    isRaw = false;
    paused = false;
    rawChanges: boolean[] = [];
    pauseCalls = 0;
    isPaused() { return this.paused; }
    setRawMode(value: boolean) { this.isRaw = value; this.rawChanges.push(value); }
    resume() { this.paused = false; }
    pause() { this.paused = true; this.pauseCalls++; }
    async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {}
  }
  const input = new TestInput();
  const output: string[] = [];
  const secret = promptSecret("Secret: ", input, { write: (value) => output.push(value) });
  input.emit("data", Buffer.from("key-value\r"));
  assert.equal(await secret, "value");
  assert.deepEqual(input.rawChanges, [true, false]);
  assert.equal(input.pauseCalls, 1);
  assert.equal(input.listenerCount("data"), 0);
  assert.deepEqual(output, ["Secret: ", "\n"]);
});

test("credential precedence is flags, environment, then selected profile file", async () => {
  const config: ProfileConfig = {
    version: 1,
    currentProfile: "saved",
    profiles: {
      saved: { region: "saved-region", baseUrl: "https://saved" },
      other: { region: "other-region" },
    },
  };
  const requested: string[] = [];
  const readCredential = async (profile: string) => { requested.push(profile); return "stored"; };
  assert.deepEqual(
    await resolveCliCredentials({ apiKey: "flag", region: "flag-region", baseUrl: "https://flag" }, config, { ARCHIL_API_KEY: "env", ARCHIL_REGION: "env-region" }, readCredential),
    { apiKey: "flag", region: "flag-region", baseUrl: "https://flag", profile: "saved" },
  );
  assert.deepEqual(
    await resolveCliCredentials({}, config, { ARCHIL_API_KEY: "key-env", ARCHIL_REGION: "env-region", ARCHIL_BASE_URL: "https://env", ARCHIL_PROFILE: "other" }, readCredential),
    { apiKey: "env", region: "env-region", baseUrl: "https://env", profile: "other" },
  );
  assert.deepEqual(
    await resolveCliCredentials({}, config, {}, readCredential),
    { apiKey: "stored", region: "saved-region", baseUrl: "https://saved", profile: "saved" },
  );
  assert.deepEqual(requested, ["saved"]);
  await assert.rejects(resolveCliCredentials({ profile: "missing" }, config, {}, readCredential), /does not exist/);
});
