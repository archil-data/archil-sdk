import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, test, vi } from "vitest";
import { createArchilProgram } from "../src/cli/archil-command.js";
import { withArchilInclude } from "../src/cli/sandbox-access.js";
import {
  cachedSandboxNames,
  completeWords,
  completionScript,
  credentialOptions,
  type CompletionSource,
} from "../src/cli/completion.js";
import {
  rememberHostKey,
  sshConfigBlock,
  sshKnownHostsPath,
  sshOptions,
  sshTarget,
} from "../src/cli/sandbox-ssh.js";
import { createUi, formatDuration, visibleLength } from "../src/cli/ui.js";
import type { Sandbox } from "../src/sandbox.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cli-access-test-"));
  vi.stubEnv("ARCHIL_DISK_CONFIG_DIR", join(directory, "config"));
  vi.stubEnv("HOME", directory);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

function sink(isTTY = false) {
  return { isTTY, values: [] as string[], write(data: string | Uint8Array) { this.values.push(typeof data === "string" ? data : Buffer.from(data).toString()); return true; } };
}

function sshSandbox(overrides: Record<string, unknown> = {}) {
  const sent: Uint8Array[] = [];
  const remote = {
    sendInput: vi.fn(async (data: Uint8Array | string) => { sent.push(typeof data === "string" ? Buffer.from(data) : data); }),
    closeStdin: vi.fn(async () => undefined),
    kill: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    output: (async function* () {
      yield { stream: "stdout", offset: 0, data: Buffer.from("SSH-2.0-OpenSSH_9.6\r\n") };
      yield { stream: "stderr", offset: 0, data: Buffer.from("sshd log line\n") };
    })(),
    wait: vi.fn(async () => ({ status: "completed", exitCode: 0, stdout: "", stderr: "" })),
  };
  const exec = vi.fn(async (command: string, _options?: { env?: Record<string, string> }) => {
    if (command.startsWith("command -v sshd")) return { status: "completed", exitCode: 0, stdout: "/usr/sbin/sshd\n", stderr: "" };
    return { status: "completed", exitCode: 0, stdout: "/usr/sbin/sshd\nssh-ed25519 AAAAHOSTKEY root@box\n", stderr: "" };
  });
  const sandbox = {
    id: "0198aabb-1234-7abc-8def-0123456789ab",
    name: "dev",
    status: "paused",
    lastActiveAt: new Date(),
    resume: vi.fn(async function(this: { status: string }) { this.status = "running"; }),
    exec,
    run: vi.fn(async () => remote),
    processes: { disconnect: vi.fn(async () => undefined) },
    ...overrides,
  } as unknown as Sandbox;
  return { sandbox, remote, sent, exec };
}

function program(sandbox: Sandbox, extra: { runSsh?: (args: string[], env: NodeJS.ProcessEnv) => Promise<number>; stdin?: NodeJS.ReadStream } = {}) {
  const stdout = sink();
  const stderr = sink();
  const exitCodes: number[] = [];
  const root = createArchilProgram({
    version: "test",
    createClient: () => ({ sandboxes: { list: async () => [sandbox], get: async () => sandbox, create: async () => sandbox } }),
    stdout,
    stderr,
    stdin: extra.stdin,
    signals: new EventEmitter() as NodeJS.Process,
    setExitCode: (code) => exitCodes.push(code),
    selfCommand: ["/usr/bin/node", "/opt/archil.mjs", "sandbox"],
    runSsh: extra.runSsh,
  });
  const run = (...args: string[]) => root.parseAsync(["node", "archil", "--api-key", "key-test", "--region", "aws-us-east-1", ...args]);
  return { run, stdout, stderr, exitCodes, root };
}

test("ssh hosts and options route through the CLI's own proxy, key, and known_hosts", () => {
  assert.equal(sshTarget("dev.archil"), "dev");
  assert.equal(sshTarget("0198aabb-1234-7abc-8def-0123456789ab"), "0198aabb-1234-7abc-8def-0123456789ab");
  const config = sshConfigBlock(["/usr/bin/node", "/My Tools/archil.mjs", "sandbox"], "/k/archil_ed25519", "/Library/Application Support/kh");
  assert.match(config, /^Host \*\.archil$/m);
  assert.match(config, /ProxyCommand \/usr\/bin\/node "\/My Tools\/archil\.mjs" sandbox ssh-proxy %n/);
  assert.match(config, /UserKnownHostsFile "\/Library\/Application Support\/kh"/);
  const options = sshOptions(["node", "cli.mjs"], "/k/key", "/a b/kh");
  assert.ok(options.includes('UserKnownHostsFile="/a b/kh"'), "values with spaces are quoted for ssh -o");
  assert.ok(options.includes("ProxyCommand=node cli.mjs ssh-proxy %n"));
});

test("rememberHostKey keeps one current entry per host", async () => {
  const path = join(directory, "known_hosts");
  await rememberHostKey(path, "dev.archil", "ssh-ed25519 OLD root@a");
  await rememberHostKey(path, "other.archil", "ssh-ed25519 OTHER root@b");
  await rememberHostKey(path, "dev.archil", "ssh-ed25519 NEW root@a\n");
  assert.equal(await readFile(path, "utf8"), "other.archil ssh-ed25519 OTHER\ndev.archil ssh-ed25519 NEW\n");
});

test("ssh runs OpenSSH against <name>.archil with the proxy and credentials", async () => {
  const { sandbox } = sshSandbox();
  const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  const cli = program(sandbox, { runSsh: async (args, env) => { calls.push({ args, env }); return 7; } });
  await cli.run("sandbox", "ssh", "dev", "--", "-L", "5432:localhost:5432", "uname", "-a");
  const [{ args, env }] = calls;
  const host = args.indexOf("dev.archil");
  assert.ok(host > 0);
  assert.deepEqual(args.slice(host + 1), ["-L", "5432:localhost:5432", "uname", "-a"]);
  assert.ok(args.includes("ProxyCommand=/usr/bin/node /opt/archil.mjs sandbox ssh-proxy %n"));
  assert.equal(env.ARCHIL_API_KEY, "key-test");
  assert.equal(env.ARCHIL_REGION, "aws-us-east-1");
  assert.deepEqual(cli.exitCodes, [7]);
  assert.match(await readFile(join(directory, ".ssh", "archil_ed25519.pub"), "utf8"), /^ssh-ed25519 /);
});

test("ssh-proxy wakes the sandbox, pins its host key, and relays sshd", async () => {
  const { sandbox, remote, sent, exec } = sshSandbox();
  const stdin = Readable.from([Buffer.from("SSH-2.0-OpenSSH_client\r\n")]) as unknown as NodeJS.ReadStream;
  const cli = program(sandbox, { stdin });
  await cli.run("sandbox", "ssh-proxy", "dev.archil");
  assert.equal((sandbox.resume as ReturnType<typeof vi.fn>).mock.calls.length, 1);
  const prepare = exec.mock.calls.find(([command]) => command.includes("authorized_keys"))!;
  assert.match(prepare[1]?.env?.ARCHIL_SSH_KEY ?? "", /^ssh-ed25519 /);
  assert.deepEqual((sandbox.run as ReturnType<typeof vi.fn>).mock.calls[0], ["exec /usr/sbin/sshd -i", { collectOutput: false }]);
  assert.equal(cli.stdout.values.join(""), "SSH-2.0-OpenSSH_9.6\r\n", "stdout carries only sshd's bytes");
  assert.match(cli.stderr.values.join(""), /sshd log line/);
  await vi.waitFor(() => assert.equal(remote.closeStdin.mock.calls.length, 1));
  assert.equal(Buffer.concat(sent).toString(), "SSH-2.0-OpenSSH_client\r\n");
  assert.equal(await readFile(sshKnownHostsPath(), "utf8"), "dev.archil ssh-ed25519 AAAAHOSTKEY\n");
  assert.deepEqual(cli.exitCodes, [0]);
});

test("ssh-proxy installs openssh-server when the image lacks it", async () => {
  let installed = false;
  const { sandbox } = sshSandbox({
    status: "running",
    exec: vi.fn(async (command: string) => {
      if (command.startsWith("command -v sshd")) return { status: "completed", exitCode: installed ? 0 : 1, stdout: installed ? "/usr/sbin/sshd\n" : "", stderr: "" };
      if (command.includes("openssh-server")) { installed = true; return { status: "completed", exitCode: 0, stdout: "", stderr: "" }; }
      return { status: "completed", exitCode: 0, stdout: "/usr/sbin/sshd\nssh-ed25519 KEY\n", stderr: "" };
    }),
  });
  const stdin = Readable.from([]) as unknown as NodeJS.ReadStream;
  const cli = program(sandbox, { stdin });
  await cli.run("sandbox", "ssh-proxy", "dev.archil");
  assert.ok(installed);
  assert.match(cli.stderr.values.join(""), /Installing openssh-server/);
});

test("ssh-config --install includes the archil hosts ahead of the user's own config", async () => {
  const { sandbox } = sshSandbox();
  const sshDir = join(directory, ".ssh");
  await mkdir(sshDir, { recursive: true });
  const userConfig = "User someone\n\nHost *\n  User alice\n  StrictHostKeyChecking no\n";
  await writeFile(join(sshDir, "config"), `${userConfig}\n# >>> archil sandboxes >>>\nHost *.archil\n  User root\n# <<< archil sandboxes <<<\n`);
  await program(sandbox).run("sandbox", "ssh-config", "--install");
  await program(sandbox).run("sandbox", "ssh-config", "--install");
  const config = await readFile(join(sshDir, "config"), "utf8");
  assert.equal(config, `Include ~/.ssh/archil_config\n\n${userConfig}`, "one Include first, the user's config untouched, the old appended block gone");
  assert.match(await readFile(join(sshDir, "archil_config"), "utf8"), /^Host \*\.archil$/m);
  assert.equal(withArchilInclude(""), "Include ~/.ssh/archil_config\n");
});

test("completion walks the command tree and fills in sandbox names and option values", async () => {
  const { sandbox } = sshSandbox();
  const { root } = program(sandbox);
  const lookup = async (source: CompletionSource) => source === "sandboxes" ? ["dev", "desk"] : ["prod"];
  assert.deepEqual(await completeWords(root, ["sa"], lookup), ["sandbox"]);
  assert.ok((await completeWords(root, [""], lookup)).includes("mount"), "native commands are suggested");
  assert.deepEqual(await completeWords(root, ["sandbox", "ss"], lookup), ["ssh", "ssh-config"]);
  assert.deepEqual(await completeWords(root, ["sandbox", "desktop", "de"], lookup), ["desk", "dev"]);
  assert.deepEqual(await completeWords(root, ["sandbox", "desktop", "dev", ""], lookup), []);
  assert.deepEqual(await completeWords(root, ["sandbox", "list", "-o", ""], lookup), ["json", "table"]);
  assert.deepEqual(await completeWords(root, ["--profile", "p"], lookup), ["prod"]);
  assert.deepEqual(await completeWords(root, ["--profile", "prod", "sandbox", "desktop", "--sh"], lookup), ["--share"]);
  assert.deepEqual(await completeWords(root, ["disk", "get", ""], lookup), []);
  for (const shell of ["bash", "zsh", "fish"]) assert.match(completionScript(shell), /archil __complete/);
  assert.throws(() => completionScript("tcsh"), /bash, zsh, or fish/);
});

test("completion uses the account typed on the line and caches per account", async () => {
  assert.deepEqual(credentialOptions(["--profile", "prod", "sandbox", "desktop", ""]), { profile: "prod" });
  assert.deepEqual(credentialOptions(["-r", "aws-us-east-1", "--api-key=key-1", "sandbox", "ssh", "d"]), { region: "aws-us-east-1", apiKey: "key-1" });
  assert.deepEqual(credentialOptions(["sandbox", "run", "dev", "--", "--profile", "x"]), {});

  const listA = vi.fn(async () => ["a1", "a1", "a2"]);
  const listB = vi.fn(async () => ["b1"]);
  assert.deepEqual(await cachedSandboxNames("account-a", listA, 1_000), ["a1", "a2"]);
  assert.deepEqual(await cachedSandboxNames("account-a", listA, 2_000), ["a1", "a2"]);
  assert.equal(listA.mock.calls.length, 1, "a fresh cache for the same account is reused");
  assert.deepEqual(await cachedSandboxNames("account-b", listB, 3_000), ["b1"], "another account never sees cached names");
  assert.deepEqual(await cachedSandboxNames("account-b", listB, 30_000), ["b1"]);
  assert.equal(listB.mock.calls.length, 2, "the cache expires");
});

test("the UI stays silent without a terminal and formats durations", async () => {
  const plain = sink(false);
  const ui = createUi(plain, { env: {} });
  assert.equal(await ui.step("Working", async () => 42), 42);
  assert.deepEqual(plain.values, []);

  const tty = sink(true);
  let clock = 0;
  const live = createUi(tty, { env: { NO_COLOR: "1" }, now: () => clock });
  await live.step("Creating dev", async () => { clock = 2500; }, "Created dev");
  assert.match(tty.values.join(""), /✓ Created dev 2\.5s\n/);
  assert.ok(!tty.values.join("").includes("\x1b[3"), "NO_COLOR disables colors");
  await assert.rejects(live.step("Failing", async () => { throw new Error("nope"); }), /nope/);
  assert.match(tty.values.join(""), /✗ Failing\n/);

  assert.equal(formatDuration(450), "450ms");
  assert.equal(formatDuration(65_000), "1m 5s");
  assert.equal(formatDuration(3_720_000), "1h 2m");
  assert.equal(visibleLength("\x1b[32m✓\x1b[39m ok"), 4);
});
