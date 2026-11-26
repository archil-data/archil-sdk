import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { createArchilProgram } from "../src/cli/archil-command.js";
import { Command } from "../src/cli/command.js";
import { addGlobalOptions, addProfileCommands, credentialFlags } from "../src/cli/common.js";
import { credentialFilePath, profileConfigPath, regionCredentialDir } from "../src/cli/config-paths.js";
import {
  deleteProfileCredential,
  promptSecret,
  readProfileCredential,
  resolveCliCredentials,
  writeProfileCredential,
} from "../src/cli/credentials.js";
import { parseRegionKeys, startLoginSession } from "../src/cli/login.js";
import { loadProfiles, profileRegions, saveProfiles, type ProfileConfig } from "../src/cli/profiles.js";
import { Archil } from "../src/archil.js";
import { completeWords, type CompletionSource } from "../src/cli/completion.js";
import { proxyEnvironment } from "../src/cli/sandbox-access.js";
import type { Sandbox } from "../src/sandbox.js";
import { startOrigin } from "./helpers/origin.js";

vi.mock("../src/cli/credentials.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/cli/credentials.js")>(),
  promptSecret: vi.fn(async () => "key-prompted"),
}));

const CONSOLE = "https://console.example.com";
let directory: string;

beforeEach(async () => {
  // The developer's shell may export real (or stale) credentials; none of them may leak in.
  const inherited = Object.keys(process.env).filter((name) => name.startsWith("ARCHIL_"));
  for (const name of new Set([...inherited, "ARCHIL_API_KEY", "ARCHIL_REGION", "ARCHIL_BASE_URL", "ARCHIL_PROFILE", "ARCHIL_CONSOLE_URL", "ARCHIL_S3_BASE_URL"])) {
    vi.stubEnv(name, undefined);
  }
  directory = await mkdtemp(join(tmpdir(), "account-profiles-test-"));
  vi.stubEnv("ARCHIL_DISK_CONFIG_DIR", join(directory, "config"));
  vi.stubEnv("HOME", directory);
  vi.stubEnv("ARCHIL_CONSOLE_URL", CONSOLE);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

function sink(isTTY = false) {
  return { isTTY, values: [] as string[], write(data: string | Uint8Array) { this.values.push(typeof data === "string" ? data : Buffer.from(data).toString()); return true; } };
}

const ACCOUNT: ProfileConfig = {
  version: 1,
  currentProfile: "acme",
  profiles: {
    acme: {
      region: "r1",
      baseUrl: "https://r1",
      apiKeyId: "tok-1",
      account: "Acme",
      accountId: "org_1",
      regions: { r2: { baseUrl: "https://r2", apiKeyId: "tok-2" }, r3: { apiKeyId: "tok-3" } },
    },
    manual: { region: "m1" },
  },
};

function resolveWith(flags: Parameters<typeof resolveCliCredentials>[0], env: NodeJS.ProcessEnv = {}) {
  const reads: Array<[string, string | undefined]> = [];
  const read = async (profile: string, _env: NodeJS.ProcessEnv, region?: string) => {
    reads.push([profile, region]);
    return `key-${profile}-${region ?? "default"}`;
  };
  return { reads, result: resolveCliCredentials(flags, ACCOUNT, env, read) };
}

test("1. --api-key uses that key with --region/--base-url, else ARCHIL_REGION/ARCHIL_BASE_URL, never a profile's", async () => {
  const env = { ARCHIL_API_KEY: "key-env", ARCHIL_REGION: "env-region", ARCHIL_BASE_URL: "https://env", ARCHIL_PROFILE: "acme" };
  assert.deepEqual(await resolveWith({ apiKey: "key-flag", region: "flag-region", baseUrl: "https://flag", profile: "acme" }, env).result,
    { apiKey: "key-flag", region: "flag-region", baseUrl: "https://flag", source: "flag" });
  assert.deepEqual(await resolveWith({ apiKey: "key-flag" }, env).result,
    { apiKey: "key-flag", region: "env-region", baseUrl: "https://env", source: "flag" });
  const { result, reads } = resolveWith({ apiKey: "key-flag" });
  await assert.rejects(result, /Missing region: --api-key needs --region/, "the current profile's region is not borrowed");
  assert.deepEqual(reads, []);
});

test("2. --profile beats ARCHIL_API_KEY and takes the chosen region's key and URL from the profile", async () => {
  const env = { ARCHIL_API_KEY: "key-env", ARCHIL_BASE_URL: "https://env" };
  assert.deepEqual(await resolveWith({ profile: "acme" }, env).result,
    { apiKey: "key-acme-default", region: "r1", baseUrl: "https://r1", profile: "acme", source: "profile" });

  const viaFlag = resolveWith({ profile: "acme", region: "r3" }, env);
  assert.deepEqual(await viaFlag.result,
    { apiKey: "key-acme-r3", region: "r3", baseUrl: undefined, profile: "acme", source: "profile" },
    "ARCHIL_BASE_URL is not combined with a profile's key");
  assert.deepEqual(viaFlag.reads, [["acme", "r3"]]);

  assert.deepEqual(await resolveWith({ profile: "acme" }, { ...env, ARCHIL_REGION: "r2" }).result,
    { apiKey: "key-acme-r2", region: "r2", baseUrl: "https://r2", profile: "acme", source: "profile" });
  assert.deepEqual(await resolveWith({ profile: "acme", region: "r2", baseUrl: "https://override" }).result,
    { apiKey: "key-acme-r2", region: "r2", baseUrl: "https://override", profile: "acme", source: "profile" });
  assert.deepEqual(await resolveWith({ profile: "acme", region: "r1" }, { ARCHIL_REGION: "r2" }).result,
    { apiKey: "key-acme-default", region: "r1", baseUrl: "https://r1", profile: "acme", source: "profile" },
    "--region beats ARCHIL_REGION");
});

test("2. a region the profile isn't signed in to is an error that says how to add it", async () => {
  await assert.rejects(resolveWith({ profile: "acme", region: "r9" }).result,
    /^Error: Profile 'acme' isn't signed in to r9\. Run 'archil login --region r9' to add it\.$/);
  await assert.rejects(resolveWith({ profile: "acme" }, { ARCHIL_REGION: "r9" }).result,
    /isn't signed in to r9 \(chosen by ARCHIL_REGION\)/);
  await assert.rejects(resolveWith({ profile: "manual", region: "r9" }).result,
    /Profile 'manual' has no key for r9\. Add one with 'profile create --profile manual --region r9'/);
  await assert.rejects(resolveWith({ profile: "missing" }).result, /Profile 'missing' does not exist/);
});

test("3. ARCHIL_API_KEY goes with ARCHIL_REGION and ARCHIL_BASE_URL as one unit; flags still override", async () => {
  assert.deepEqual(await resolveWith({}, { ARCHIL_API_KEY: "key-env", ARCHIL_REGION: "env-region", ARCHIL_BASE_URL: "https://env", ARCHIL_PROFILE: "acme" }).result,
    { apiKey: "key-env", region: "env-region", baseUrl: "https://env", source: "env" });
  assert.deepEqual(await resolveWith({ region: "flag-region", baseUrl: "https://flag" }, { ARCHIL_API_KEY: "key-env", ARCHIL_REGION: "env-region" }).result,
    { apiKey: "key-env", region: "flag-region", baseUrl: "https://flag", source: "env" });
  await assert.rejects(resolveWith({}, { ARCHIL_API_KEY: "key-env" }).result,
    /Missing region: ARCHIL_API_KEY needs ARCHIL_REGION/, "the current profile's region is not borrowed");
});

test("4. otherwise ARCHIL_PROFILE, else the current profile, with the same region choice", async () => {
  assert.deepEqual(await resolveWith({}).result,
    { apiKey: "key-acme-default", region: "r1", baseUrl: "https://r1", profile: "acme", source: "profile" });
  assert.deepEqual(await resolveWith({ region: "r2" }).result,
    { apiKey: "key-acme-r2", region: "r2", baseUrl: "https://r2", profile: "acme", source: "profile" });
  assert.deepEqual(await resolveWith({}, { ARCHIL_PROFILE: "manual" }).result,
    { apiKey: "key-manual-default", region: "m1", baseUrl: undefined, profile: "manual", source: "profile" });
  await assert.rejects(resolveWith({}, { ARCHIL_PROFILE: "manual", ARCHIL_REGION: "r1" }).result, /has no key for r1/);
});

test("5. no key anywhere keeps the original error", async () => {
  await assert.rejects(resolveCliCredentials({}, { profiles: {} }, {}), /^Error: Missing API key: pass --api-key, set ARCHIL_API_KEY, or run 'profile create'$/);
});

test("credential flags only include options typed on the command line, not their environment variables", async () => {
  vi.stubEnv("ARCHIL_API_KEY", "key-env");
  vi.stubEnv("ARCHIL_PROFILE", "env-profile");
  const program = new Command().name("archil");
  addGlobalOptions(program);
  let seen: ReturnType<typeof credentialFlags> | undefined;
  program.command("probe").action(() => { seen = credentialFlags(program); });
  await program.parseAsync(["node", "archil", "--region", "r2", "probe"]);
  assert.deepEqual(seen, { apiKey: undefined, region: "r2", baseUrl: undefined, profile: undefined });
  assert.equal(program.getOptionValueSource("apiKey"), "env");
  assert.equal(program.getOptionValueSource("region"), "cli");
  assert.equal(program.getOptionValueSource("baseUrl"), undefined);
});

test("commands use an explicit --profile even when ARCHIL_API_KEY is exported", async () => {
  await writeProfileCredential("acme", "key-saved");
  await writeProfileCredential("acme", "key-saved-west", undefined, "aws-us-west-2");
  await saveProfiles({ version: 1, profiles: { acme: { region: "aws-us-east-1", regions: { "aws-us-west-2": {} } } } });
  vi.stubEnv("ARCHIL_API_KEY", "key-stale");
  vi.stubEnv("ARCHIL_REGION", "aws-us-west-2");
  const clients: unknown[] = [];
  const sandbox = { id: "0198aabb-1234-7abc-8def-0123456789ab", name: "dev", status: "running", lastActiveAt: new Date() } as unknown as Sandbox;
  const program = createArchilProgram({
    version: "test",
    createClient: (options) => { clients.push(options); return { sandboxes: { list: async () => [sandbox], get: async () => sandbox, create: async () => sandbox } }; },
    stdout: sink(),
    stderr: sink(),
  });
  await program.parseAsync(["node", "archil", "--profile", "acme", "sandbox", "list"]);
  assert.deepEqual(clients, [{ apiKey: "key-saved-west", region: "aws-us-west-2", baseUrl: undefined, profile: "acme", source: "profile" }]);
});

test("a config written before multi-region profiles reads and resolves unchanged", async () => {
  await mkdir(join(directory, "config", "credentials"), { recursive: true });
  await writeFile(profileConfigPath(), JSON.stringify({
    version: 1,
    currentProfile: "aws-us-east-1",
    profiles: { "aws-us-east-1": { region: "aws-us-east-1", apiKeyId: "tok-1", account: "Acme" } },
  }));
  await writeFile(credentialFilePath("aws-us-east-1"), "key-old\n", { mode: 0o600 });
  const config = await loadProfiles();
  assert.deepEqual(profileRegions(config.profiles["aws-us-east-1"]!), ["aws-us-east-1"]);
  assert.deepEqual(await resolveCliCredentials({}, config, process.env),
    { apiKey: "key-old", region: "aws-us-east-1", baseUrl: undefined, profile: "aws-us-east-1", source: "profile" });
  await writeFile(profileConfigPath(), JSON.stringify({ version: 1, profiles: { bad: { region: "r", regions: [] } } }));
  await assert.rejects(loadProfiles(), /invalid regions field/);
});

test("region keys are stored beside the default key with the same protections", async () => {
  await writeProfileCredential("acme", "key-default");
  await writeProfileCredential("acme", "key-west", undefined, "aws-us-west-2");
  const path = credentialFilePath("acme", process.env, "aws-us-west-2");
  assert.equal(path, join(directory, "config", "credentials", "acme.regions", "aws-us-west-2.key"));
  assert.equal(await readProfileCredential("acme", process.env, "aws-us-west-2"), "key-west");
  assert.equal(await readProfileCredential("acme"), "key-default");
  if (process.platform !== "win32") {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(regionCredentialDir("acme"))).mode & 0o777, 0o700);
    await chmod(path, 0o640);
    await assert.rejects(readProfileCredential("acme", process.env, "aws-us-west-2"), /permissions must be 0600/);
  }
  await deleteProfileCredential("acme");
  await assert.rejects(stat(credentialFilePath("acme")), { code: "ENOENT" });
  await assert.rejects(stat(regionCredentialDir("acme")), { code: "ENOENT" });
});

function loginProgram(fields: () => Record<string, string>, opened: string[] = []) {
  const stderr = sink();
  const program = createArchilProgram({
    version: "test",
    createClient: () => { throw new Error("unused"); },
    stderr,
    validateCredential: async ({ region }) => region!,
    openUrl: (url) => {
      opened.push(url);
      const params = new URL(url).searchParams;
      void fetch(`http://127.0.0.1:${params.get("port")}/callback`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: CONSOLE },
        body: new URLSearchParams({ state: params.get("state")!, ...fields() }),
      });
    },
  });
  return { program, output: () => stderr.values.join("") };
}

function grant(account: string, accountId: string, keys: Array<{ region: string; apiKey: string; keyId: string; baseUrl?: string }>) {
  const [first] = keys;
  return { apiKey: first!.apiKey, region: first!.region, keyId: first!.keyId, ...(first!.baseUrl ? { baseUrl: first!.baseUrl } : {}), account, accountId, keys: JSON.stringify(keys) };
}

test("login saves every region's key in one profile named after the account, and a re-login replaces them", async () => {
  await saveProfiles({ version: 1, profiles: { "acme-inc": { region: "aws-us-east-1" } } });
  const first = loginProgram(() => grant("Acme Inc", "org_1", [
    { region: "aws-us-east-1", apiKey: "key-east", keyId: "tok-east" },
    { region: "aws-us-west-2", apiKey: "key-west", keyId: "tok-west" },
    { region: "gcp-us-central1", apiKey: "key-gcp", keyId: "tok-gcp", baseUrl: "https://gcp.example.com" },
  ]));
  await first.program.parseAsync(["node", "archil", "login"]);
  assert.match(first.output(), /Signed in to Acme Inc as profile acme-inc-2 \(regions: aws-us-east-1, aws-us-west-2, gcp-us-central1; default aws-us-east-1\)/);

  let config = await loadProfiles();
  assert.equal(config.currentProfile, "acme-inc-2");
  assert.deepEqual(config.profiles["acme-inc"], { region: "aws-us-east-1" }, "the hand-made profile is untouched");
  assert.deepEqual(config.profiles["acme-inc-2"], {
    region: "aws-us-east-1",
    apiKeyId: "tok-east",
    account: "Acme Inc",
    accountId: "org_1",
    regions: {
      "aws-us-west-2": { apiKeyId: "tok-west" },
      "gcp-us-central1": { baseUrl: "https://gcp.example.com", apiKeyId: "tok-gcp" },
    },
  });
  assert.equal(await readProfileCredential("acme-inc-2"), "key-east");
  assert.equal(await readProfileCredential("acme-inc-2", process.env, "aws-us-west-2"), "key-west");
  assert.equal(await readProfileCredential("acme-inc-2", process.env, "gcp-us-central1"), "key-gcp");
  assert.ok(!(await readFile(profileConfigPath(), "utf8")).includes("key-"), "no secret in the config file");

  const second = loginProgram(() => grant("Acme, Inc.", "org_1", [
    { region: "aws-us-west-2", apiKey: "key-west-new", keyId: "tok-west-new" },
    { region: "aws-us-east-1", apiKey: "key-east-new", keyId: "tok-east-new" },
  ]));
  await second.program.parseAsync(["node", "archil", "login"]);
  assert.match(second.output(), /as profile acme-inc-2 \(regions: aws-us-west-2, aws-us-east-1; default aws-us-west-2\)/);
  config = await loadProfiles();
  assert.deepEqual(Object.keys(config.profiles).sort(), ["acme-inc", "acme-inc-2"], "no new profile piles up");
  assert.deepEqual(config.profiles["acme-inc-2"], {
    region: "aws-us-west-2",
    apiKeyId: "tok-west-new",
    account: "Acme, Inc.",
    accountId: "org_1",
    regions: { "aws-us-east-1": { apiKeyId: "tok-east-new" } },
  });
  assert.equal(await readProfileCredential("acme-inc-2"), "key-west-new");
  assert.equal(await readProfileCredential("acme-inc-2", process.env, "aws-us-east-1"), "key-east-new");
  assert.deepEqual(await readdir(regionCredentialDir("acme-inc-2")), ["aws-us-east-1.key"], "the dropped region's key is deleted");
});

test("a 0.1.0-style callback without keys saves one region; login --region asks the console for it", async () => {
  const opened: string[] = [];
  const login = loginProgram(() => ({ apiKey: "key-one", region: "aws-eu-west-1", keyId: "tok-1", account: "Solo" }), opened);
  await login.program.parseAsync(["node", "archil", "--region", "aws-eu-west-1", "login"]);
  assert.equal(new URL(opened[0]!).searchParams.get("region"), "aws-eu-west-1");
  assert.match(login.output(), /Signed in to Solo as profile solo \(region aws-eu-west-1\)/);
  assert.deepEqual((await loadProfiles()).profiles.solo, { region: "aws-eu-west-1", apiKeyId: "tok-1", account: "Solo" });

  vi.stubEnv("ARCHIL_REGION", "aws-us-west-2");
  const plain: string[] = [];
  await loginProgram(() => ({ apiKey: "key-one", region: "aws-eu-west-1", account: "Solo" }), plain).program.parseAsync(["node", "archil", "login"]);
  assert.equal(new URL(plain[0]!).searchParams.get("region"), null, "only a typed --region is sent");
});

test("the callback rejects a malformed keys field with a 400", async () => {
  for (const keys of ["not json", "{}", "[1]", '[{"region":"r"}]', '[{"apiKey":"key-x"}]', '[{"region":"r","apiKey":"key-x","keyId":3}]', '[{"region":"r","apiKey":"a"},{"region":"r","apiKey":"b"}]']) {
    const session = await startLoginSession({ console: CONSOLE });
    const params = new URL(session.url).searchParams;
    const response = await fetch(`http://127.0.0.1:${params.get("port")}/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: CONSOLE },
      body: new URLSearchParams({ state: params.get("state")!, apiKey: "key-x", region: "r", keys }),
    });
    assert.equal(response.status, 400, keys);
    await assert.rejects(session.grant, /malformed keys/);
  }
  assert.deepEqual(parseRegionKeys(null), []);
  assert.deepEqual(parseRegionKeys('[{"region":"r","apiKey":"key-x","keyId":"t","baseUrl":""}]'), [{ region: "r", apiKey: "key-x", keyId: "t", baseUrl: undefined }]);
});

test("logout and profile delete remove every region's key", async () => {
  for (const name of ["one", "two"]) {
    await writeProfileCredential(name, `key-${name}`);
    await writeProfileCredential(name, `key-${name}-west`, undefined, "aws-us-west-2");
  }
  await saveProfiles({
    version: 1,
    currentProfile: "one",
    profiles: {
      one: { region: "aws-us-east-1", apiKeyId: "tok", regions: { "aws-us-west-2": { apiKeyId: "tok-w" } } },
      two: { region: "aws-us-east-1", regions: { "aws-us-west-2": {} } },
    },
  });
  const stderr = sink();
  const program = createArchilProgram({ version: "test", createClient: () => { throw new Error("unused"); }, stderr });
  await program.parseAsync(["node", "archil", "logout"]);
  assert.match(stderr.values.join(""), /Signed out of one; its keys are no longer saved/);
  vi.spyOn(console, "log").mockImplementation(() => {});
  await createArchilProgram({ version: "test", createClient: () => { throw new Error("unused"); }, stderr }).parseAsync(["node", "archil", "profile", "delete", "two"]);
  assert.deepEqual(await loadProfiles(), { version: 1, profiles: {} });
  assert.deepEqual(await readdir(join(directory, "config", "credentials")), []);
});

function profileCli() {
  const program = new Command().name("disk");
  addGlobalOptions(program);
  addProfileCommands(program, async ({ apiKey, region }) => region ?? (apiKey.includes("west") ? "aws-us-west-2" : "aws-us-east-1"));
  return program;
}

test("profile create prompts for the key even when ARCHIL_API_KEY is set", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubEnv("ARCHIL_API_KEY", "key-from-env");
  await profileCli().parseAsync(["node", "disk", "--profile", "work", "--region", "aws-us-east-1", "profile", "create"]);
  assert.equal(vi.mocked(promptSecret).mock.calls.length, 1);
  assert.equal(await readProfileCredential("work"), "key-prompted");

  vi.mocked(promptSecret).mockClear();
  await profileCli().parseAsync(["node", "disk", "--profile", "typed", "--api-key", "key-typed", "--region", "aws-us-east-1", "profile", "create"]);
  assert.equal(vi.mocked(promptSecret).mock.calls.length, 0, "a typed --api-key needs no prompt");
  assert.equal(await readProfileCredential("typed"), "key-typed");
});

test("profile create adds a region to an existing profile and refuses one it already has", async () => {
  const logs: string[] = [];
  vi.spyOn(console, "log").mockImplementation((value) => logs.push(String(value)));
  const run = (...args: string[]) => profileCli().parseAsync(["node", "disk", ...args]);
  await run("--profile", "work", "--api-key", "key-east", "profile", "create");
  await run("--profile", "work", "--api-key", "key-west", "profile", "create");
  assert.match(logs.at(-1)!, /Added aws-us-west-2 to profile 'work'/);
  assert.deepEqual((await loadProfiles()).profiles.work, { region: "aws-us-east-1", regions: { "aws-us-west-2": {} } });
  assert.equal(await readProfileCredential("work"), "key-east");
  assert.equal(await readProfileCredential("work", process.env, "aws-us-west-2"), "key-west");
  await assert.rejects(run("--profile", "work", "--api-key", "key-west-2", "profile", "create"), /already exists and has a key for aws-us-west-2/);
  assert.equal(await readProfileCredential("work", process.env, "aws-us-west-2"), "key-west");

  logs.length = 0;
  await run("profile", "list", "-o", "text");
  assert.deepEqual(logs, ["* work\taws-us-east-1\tdefault\taws-us-east-1,aws-us-west-2"]);
  logs.length = 0;
  await run("profile", "list", "-o", "json");
  assert.deepEqual(JSON.parse(logs[0]!), [{ name: "work", region: "aws-us-east-1", regions: ["aws-us-east-1", "aws-us-west-2"], current: true }]);
});

test("whoami names the account, profile, region, source, and the profile's other regions", async () => {
  await writeProfileCredential("acme", "key-east-1234");
  await writeProfileCredential("acme", "key-west-5678", undefined, "aws-us-west-2");
  await saveProfiles({
    version: 1,
    currentProfile: "acme",
    profiles: { acme: { region: "aws-us-east-1", apiKeyId: "tok", account: "Acme", regions: { "aws-us-west-2": {}, "aws-eu-west-1": {} } } },
  });
  const whoami = async (...args: string[]) => {
    const stderr = sink();
    await createArchilProgram({ version: "test", createClient: () => { throw new Error("unused"); }, stderr, validateCredential: async ({ region }) => region! })
      .parseAsync(["node", "archil", ...args, "whoami"]);
    return stderr.values.join("");
  };
  const west = await whoami("--region", "aws-us-west-2");
  assert.match(west, /Account\s+Acme/);
  assert.match(west, /Profile\s+acme/);
  assert.match(west, /Region\s+aws-us-west-2\n/);
  assert.match(west, /Also\s+aws-us-east-1, aws-eu-west-1/);
  assert.match(west, /Source\s+saved profile/);
  assert.match(west, /…5678/);
  assert.match(await whoami(), /Region\s+aws-us-east-1 \(default\)/);

  vi.stubEnv("ARCHIL_API_KEY", "key-env-9999");
  vi.stubEnv("ARCHIL_REGION", "aws-us-east-1");
  const env = await whoami();
  assert.match(env, /Profile\s+none/);
  assert.match(env, /Source\s+ARCHIL_API_KEY/);
  assert.doesNotMatch(env, /Account|Also/);
});

test("ssh-config pins --region when the region in use isn't the profile's default", async () => {
  await writeProfileCredential("acme", "key-east");
  await writeProfileCredential("acme", "key-west", undefined, "aws-us-west-2");
  await saveProfiles({ version: 1, currentProfile: "acme", profiles: { acme: { region: "aws-us-east-1", regions: { "aws-us-west-2": { baseUrl: "https://west" } } } } });
  const sandbox = { id: "0198aabb-1234-7abc-8def-0123456789ab", name: "dev", status: "running", lastActiveAt: new Date() } as unknown as Sandbox;
  await mkdir(join(directory, ".ssh"), { recursive: true });
  const sshConfig = async (...args: string[]) => {
    const stdout = sink();
    await createArchilProgram({
      version: "test",
      createClient: () => ({ sandboxes: { list: async () => [sandbox], get: async () => sandbox, create: async () => sandbox } }),
      stdout,
      stderr: sink(),
      selfCommand: ["/usr/bin/node", "/opt/archil.mjs", "sandbox"],
    }).parseAsync(["node", "archil", ...args, "sandbox", "ssh-config"]);
    return stdout.values.join("");
  };
  assert.match(await sshConfig(), /ProxyCommand \/usr\/bin\/node \/opt\/archil\.mjs sandbox --profile acme ssh-proxy %n/);
  assert.match(await sshConfig("--region", "aws-us-west-2"), /sandbox --profile acme --region aws-us-west-2 ssh-proxy %n/);
});

test("archil sandbox ssh hands the proxy only the resolved credentials, dropping a stale ARCHIL_BASE_URL", () => {
  const env = proxyEnvironment(
    { PATH: "/bin", ARCHIL_API_KEY: "key-stale", ARCHIL_REGION: "stale", ARCHIL_BASE_URL: "https://stale" },
    { apiKey: "key-saved", region: "aws-us-west-2", profile: "acme", source: "profile" },
  );
  assert.deepEqual(env, { PATH: "/bin", ARCHIL_API_KEY: "key-saved", ARCHIL_REGION: "aws-us-west-2" });
  assert.equal(proxyEnvironment({}, { apiKey: "k", region: "r", baseUrl: "https://b", source: "flag" }).ARCHIL_BASE_URL, "https://b");
});

test("completion offers the profile's regions for --region", async () => {
  const root = createArchilProgram({ version: "test", createClient: () => { throw new Error("unused"); } });
  const lookup = async (source: CompletionSource) => source === "regions" ? ["aws-us-east-1", "aws-us-west-2", "gcp-us-central1"] : [];
  assert.deepEqual(await completeWords(root, ["--region", "aws"], lookup), ["aws-us-east-1", "aws-us-west-2"]);
  assert.deepEqual(await completeWords(root, ["sandbox", "list", "-r", "g"], lookup), ["gcp-us-central1"]);
});

test("the library honors ARCHIL_BASE_URL along with ARCHIL_REGION, but not beside an explicit region", async () => {
  const origin = await startOrigin(() => ({ status: 404, body: "{}" }));
  try {
    vi.stubEnv("ARCHIL_API_KEY", "key-env");
    vi.stubEnv("ARCHIL_REGION", "custom-region");
    vi.stubEnv("ARCHIL_BASE_URL", origin.url);
    await new Archil().disks.list().catch(() => {});
    assert.ok(origin.requests.length > 0, "requests go to ARCHIL_BASE_URL");
    assert.equal(origin.requests[0]!.headers.get("authorization"), "Bearer key-env");
    assert.throws(() => new Archil({ region: "custom-region" }), /Unknown region/, "an explicit region doesn't borrow the environment's base URL");
  } finally {
    await origin.close();
  }
});
