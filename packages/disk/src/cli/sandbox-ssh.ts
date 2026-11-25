// SSH into sandboxes without opening a port. ssh's ProxyCommand runs
// `sandbox ssh-proxy <target>`, which starts `sshd -i` in the sandbox through
// the process API and relays ssh's stdin/stdout over it. sshd then
// authenticates the CLI's own key, so scp, rsync, port forwarding, and editor
// remotes (VS Code, Cursor) all work.

import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { Sandbox } from "../sandbox.js";
import { diskConfigDir } from "./config-paths.js";
import { writeOutput, type OutputStream } from "./write-output.js";

export const SSH_HOST_SUFFIX = ".archil";

export function sshKeyPath(home = homedir()): string {
  return join(home, ".ssh", "archil_ed25519");
}

export function sshKnownHostsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(diskConfigDir(env), "known_hosts");
}

/** `my-desk.archil` and `my-desk` both name the sandbox `my-desk`. */
export function sshTarget(host: string): string {
  return host.endsWith(SSH_HOST_SUFFIX) ? host.slice(0, -SSH_HOST_SUFFIX.length) : host;
}

/** Creates the CLI's SSH key on first use; returns its public key. */
export async function ensureSshKey(keyPath = sshKeyPath()): Promise<string> {
  try {
    return (await readFile(`${keyPath}.pub`, "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dirname(keyPath), { recursive: true, mode: 0o700 });
  try {
    await promisify(execFile)("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "archil-cli", "-f", keyPath]);
  } catch (error) {
    throw new Error(`Couldn't create an SSH key with ssh-keygen: ${error instanceof Error ? error.message : String(error)}`);
  }
  return (await readFile(`${keyPath}.pub`, "utf8")).trim();
}

/** Records `hostKey` for `host` in the CLI's known_hosts file, replacing any older entry. */
export async function rememberHostKey(knownHostsPath: string, host: string, hostKey: string): Promise<void> {
  let lines: string[] = [];
  try {
    lines = (await readFile(knownHostsPath, "utf8")).split("\n").filter(Boolean);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const entry = `${host} ${hostKey.trim().split(/\s+/).slice(0, 2).join(" ")}`;
  const kept = lines.filter((line) => line.split(" ")[0] !== host);
  await mkdir(dirname(knownHostsPath), { recursive: true });
  const temporary = `${knownHostsPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${[...kept, entry].join("\n")}\n`, { mode: 0o600 });
  await rename(temporary, knownHostsPath);
}

const FIND_SSHD = "command -v sshd || { [ -x /usr/sbin/sshd ] && echo /usr/sbin/sshd; }";

const INSTALL_SSHD = `
if command -v apt-get >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq && apt-get install -y -qq --no-install-recommends openssh-server
elif command -v apk >/dev/null; then
  apk add --no-cache openssh-server
elif command -v dnf >/dev/null; then
  dnf install -y -q openssh-server
else
  echo "no supported package manager to install openssh-server" >&2
  exit 1
fi`;

// Authorizes the CLI's key for root and prints the sshd path and host key.
const PREPARE_SSHD = `
set -e
sshd=$(${FIND_SSHD})
mkdir -p /run/sshd /root/.ssh
chmod 700 /root/.ssh
ssh-keygen -A >/dev/null
touch /root/.ssh/authorized_keys
grep -qxF "$ARCHIL_SSH_KEY" /root/.ssh/authorized_keys || printf '%s\\n' "$ARCHIL_SSH_KEY" >> /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
echo "$sshd"
cat /etc/ssh/ssh_host_ed25519_key.pub`;

/**
 * Makes sure the sandbox can serve SSH for `publicKey`, installing
 * openssh-server the first time if needed. Returns the sshd path and the
 * sandbox's host key.
 */
export async function prepareSandboxSsh(
  sandbox: Sandbox,
  publicKey: string,
  notify: (message: string) => void,
): Promise<{ sshd: string; hostKey: string }> {
  const found = await sandbox.exec(FIND_SSHD);
  if (!found.stdout.trim()) {
    notify(`Installing openssh-server in '${sandbox.name}' (first SSH connection only)...`);
    const installed = await sandbox.exec(INSTALL_SSHD, { timeoutSeconds: 300 });
    if (installed.exitCode !== 0) {
      throw new Error(`Couldn't install openssh-server in '${sandbox.name}': ${(installed.stderr || installed.stdout).trim().split("\n").slice(-3).join("\n")}`);
    }
  }
  const prepared = await sandbox.exec(PREPARE_SSHD, { env: { ARCHIL_SSH_KEY: publicKey } });
  const [sshd, hostKey] = prepared.stdout.trim().split("\n");
  if (prepared.exitCode !== 0 || !sshd || !hostKey) {
    throw new Error(`Couldn't set up SSH in '${sandbox.name}': ${(prepared.stderr || prepared.stdout).trim()}`);
  }
  return { sshd, hostKey };
}

/** Relays an sshd running in inetd mode inside the sandbox over `input`/`output`. Resolves to its exit code. */
export async function relaySshd(
  sandbox: Sandbox,
  sshd: string,
  input: AsyncIterable<Uint8Array | string>,
  output: OutputStream,
  errors: OutputStream,
): Promise<number> {
  const remote = await sandbox.run(`exec ${sshd} -i`, { collectOutput: false });
  const forwardInput = (async () => {
    for await (const chunk of input) await remote.sendInput(chunk);
    await remote.closeStdin();
  })().catch(() => remote.kill().catch(() => {}));
  try {
    for await (const { stream, data } of remote.output) {
      await writeOutput(stream === "stdout" ? output : errors, data);
    }
    const result = await remote.wait();
    return result.exitCode ?? (result.status === "completed" ? 0 : 1);
  } finally {
    void forwardInput;
    await remote.disconnect().catch(() => {});
    await sandbox.processes.disconnect().catch(() => {});
  }
}

/** The ProxyCommand that runs this CLI's `ssh-proxy` command for `%n`, the host as typed. */
export function proxyCommand(cliArgs: string[]): string {
  return [...cliArgs, "ssh-proxy", "%n"].map(quoteForSsh).join(" ");
}

/** An ssh_config block that sends every `<sandbox>.archil` host through the CLI. */
export function sshConfigBlock(cliArgs: string[], keyPath = sshKeyPath(), knownHostsPath = sshKnownHostsPath()): string {
  return [
    "# Archil sandboxes: ssh <sandbox-name>.archil",
    `Host *${SSH_HOST_SUFFIX}`,
    "  User root",
    `  IdentityFile ${quoteForSsh(keyPath)}`,
    "  IdentitiesOnly yes",
    `  UserKnownHostsFile ${quoteForSsh(knownHostsPath)}`,
    "  StrictHostKeyChecking yes",
    `  ProxyCommand ${proxyCommand(cliArgs)}`,
    "",
  ].join("\n");
}

/** ssh options equivalent to `sshConfigBlock`, for running ssh without editing ~/.ssh/config. */
export function sshOptions(cliArgs: string[], keyPath = sshKeyPath(), knownHostsPath = sshKnownHostsPath()): string[] {
  return [
    "-o", "User=root",
    "-o", `IdentityFile=${quoteForSsh(keyPath)}`,
    "-o", "IdentitiesOnly=yes",
    "-o", `UserKnownHostsFile=${quoteForSsh(knownHostsPath)}`,
    "-o", "StrictHostKeyChecking=yes",
    "-o", `ProxyCommand=${proxyCommand(cliArgs)}`,
  ];
}

function quoteForSsh(value: string): string {
  return /^[\w./%@:+-]+$/.test(value) ? value : `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
