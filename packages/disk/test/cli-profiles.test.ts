import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, test, vi } from "vitest";
import { addGlobalOptions, addProfileCommands } from "../src/cli/common.js";
import { validateCredentialAndResolveRegion } from "../src/cli/credential-validation.js";
import { credentialFilePath, diskConfigDir, profileConfigPath } from "../src/cli/config-paths.js";
import {
  deleteProfileCredential,
  validateApiKey,
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
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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
  assert.equal(await readProfileCredential("test", env), "key-secret");
  if (process.platform !== "win32") {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await chmod(path, 0o644);
    await assert.rejects(readProfileCredential("test", env), /permissions must be 0600/);
  }
  await deleteProfileCredential("test", env);
  await assert.rejects(readFile(path), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  await assert.rejects(readProfileCredential("test", env), /Missing API key for profile 'test'.*profile create/);
  assert.equal(validateApiKey("key-one"), "key-one");
  assert.equal(validateApiKey("adt_two"), "adt_two");
  assert.throws(() => validateApiKey(""), /empty/);
  assert.throws(() => validateApiKey("key one"), /whitespace/);
});

test("profile creation validates explicit regions and auto-detects known production regions", async () => {
  const probes: string[] = [];
  const keys: string[] = [];
  const probe = async ({ apiKey, region }: { apiKey: string; region: string }) => {
    keys.push(apiKey);
    probes.push(region);
    if (region !== "aws-eu-west-1") throw new Error("not here");
  };
  assert.equal(
    await validateCredentialAndResolveRegion({ apiKey: " key-test\n" }, probe),
    "aws-eu-west-1",
  );
  assert.deepEqual(probes, ["aws-us-east-1", "aws-us-west-2", "aws-eu-west-1"]);
  assert.deepEqual(keys, ["key-test", "key-test", "key-test"]);

  probes.length = 0;
  assert.equal(
    await validateCredentialAndResolveRegion(
      { apiKey: "key-test", region: "custom", baseUrl: "https://control.test" },
      async ({ region }) => { probes.push(region); },
    ),
    "custom",
  );
  assert.deepEqual(probes, ["custom"]);
  await assert.rejects(
    validateCredentialAndResolveRegion({ apiKey: "key-test", baseUrl: "https://control.test" }, probe),
    /custom environments cannot be auto-detected/,
  );
});

function profileCli() {
  const program = new Command().name("disk");
  addGlobalOptions(program);
  addProfileCommands(program, async ({ region }) => region ?? "aws-us-east-1");
  return program;
}

async function runProfileCli(...args: string[]) {
  return profileCli().parseAsync(["node", "disk", ...args]);
}

test("nested profile help shows inherited credential and profile options", () => {
  const program = profileCli();
  const profile = program.commands.find((command) => command.name() === "profile");
  const create = profile?.commands.find((command) => command.name() === "create");
  assert.ok(create);
  assert.equal(profile?.commands.some((command) => ["login", "logout"].includes(command.name())), false);
  const help = create.helpInformation();
  for (const option of ["--api-key", "--region", "--base-url", "--profile"]) {
    assert.match(help, new RegExp(option));
  }
  assert.match(help, /Global Options:/);
});

test("profile create honors CLI and environment names without replacing secrets", async () => {
  const env = await temporaryEnv();
  vi.stubEnv("ARCHIL_DISK_CONFIG_DIR", env.ARCHIL_DISK_CONFIG_DIR);
  vi.spyOn(console, "log").mockImplementation(() => {});

  await runProfileCli("--profile", "named", "--region", "test", "--base-url", "https://test-one", "--api-key", "key-one", "profile", "create");
  assert.deepEqual((await loadProfiles(env)).profiles.named, {
    region: "test",
    baseUrl: "https://test-one",
  });
  await assert.rejects(
    runProfileCli("--profile", "named", "--region", "aws-us-east-1", "--api-key", "key-replacement", "profile", "create"),
    /already exists/,
  );
  assert.equal(await readProfileCredential("named", env), "key-one");

  vi.stubEnv("ARCHIL_PROFILE", "from-env");
  await runProfileCli("--region", "aws-us-west-2", "--api-key", "key-env", "profile", "create");
  const config = await loadProfiles(env);
  assert.deepEqual(config.profiles["from-env"], { region: "aws-us-west-2" });
  assert.equal(config.currentProfile, "from-env");
  assert.equal(await readProfileCredential("from-env", env), "key-env");
});

test("unnamed profile creation allocates a fresh name for every credential", async () => {
  const env = await temporaryEnv();
  vi.stubEnv("ARCHIL_DISK_CONFIG_DIR", env.ARCHIL_DISK_CONFIG_DIR);
  vi.spyOn(console, "log").mockImplementation(() => {});

  await runProfileCli("--region", "aws-us-east-1", "--api-key", "key-one", "profile", "create");
  await runProfileCli("--region", "aws-us-east-1", "--api-key", "key-two", "profile", "create");
  const config = await loadProfiles(env);
  assert.deepEqual(config.profiles, {
    "aws-us-east-1": { region: "aws-us-east-1" },
    "aws-us-east-1-2": { region: "aws-us-east-1" },
  });
  assert.equal(await readProfileCredential("aws-us-east-1", env), "key-one");
  assert.equal(await readProfileCredential("aws-us-east-1-2", env), "key-two");
});

test("profile list renders a table and delete removes metadata and credentials", async () => {
  const env = await temporaryEnv();
  vi.stubEnv("ARCHIL_DISK_CONFIG_DIR", env.ARCHIL_DISK_CONFIG_DIR);
  const logs: string[] = [];
  vi.spyOn(console, "log").mockImplementation((value) => logs.push(String(value)));

  await runProfileCli("--profile", "active", "--region", "aws-us-east-1", "--api-key", "key-active-secret", "profile", "create");
  await runProfileCli("--profile", "other", "--region", "aws-us-west-2", "--api-key", "key-other-secret", "profile", "create");
  logs.length = 0;
  await runProfileCli("profile", "list");

  const output = logs.join("\n");
  assert.match(output, /│ current │ name\s+│ region/);
  assert.match(output, /│ \*\s+│ other\s+│ aws-us-west-2/);
  assert.equal(output.includes("active-secret"), false);
  assert.equal(output.includes("other-secret"), false);

  await runProfileCli("profile", "delete", "other");
  assert.equal((await loadProfiles(env)).profiles.other, undefined);
  await assert.rejects(readProfileCredential("other", env), /profile create/);
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
    { apiKey: "key-env", region: "env-region", baseUrl: "https://env", profile: "other" },
  );
  assert.deepEqual(
    await resolveCliCredentials({}, config, {}, readCredential),
    { apiKey: "stored", region: "saved-region", baseUrl: "https://saved", profile: "saved" },
  );
  assert.deepEqual(requested, ["saved"]);
  await assert.rejects(resolveCliCredentials({ profile: "missing" }, config, {}, readCredential), /does not exist/);
});
