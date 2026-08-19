#!/usr/bin/env node
import type { SandboxProcessResult, SandboxProcessStartOptions } from "../src/sandbox-process.js";
import type { Sandbox, SandboxExec } from "../src/sandbox.js";
import { runSandboxTui } from "../src/tui/run.js";

const now = Date.now();
let serial = 0;
const execs = new Map<string, SandboxExec[]>();

function fixtureSandbox(data: Partial<Sandbox> & Pick<Sandbox, "id" | "name" | "status">): Sandbox {
  const sandbox = {
    vcpuCount: 2, memSizeMiB: 2048, baseImage: "ubuntu:26.04", platform: "arm64",
    maxTtlSeconds: 7200, maxConcurrentExecs: 8, createdAt: new Date(now - 3600_000),
    lastActiveAt: new Date(now - 10_000),
    ...data,
  } as Sandbox;
  sandbox.start = async () => { sandbox.status = "pending"; setTimeout(() => { sandbox.status = "running"; }, 300); return sandbox; };
  sandbox.pause = async () => { sandbox.status = "pausing"; setTimeout(() => { sandbox.status = "paused"; }, 300); return sandbox; };
  sandbox.resume = async () => { sandbox.status = "pending"; setTimeout(() => { sandbox.status = "running"; }, 300); return sandbox; };
  sandbox.stop = async () => { sandbox.status = "stopping"; setTimeout(() => { sandbox.status = "stopped"; }, 300); return sandbox; };
  sandbox.delete = async () => { sandbox.status = "deleted"; const index = fixtures.indexOf(sandbox); if (index >= 0) fixtures.splice(index, 1); };
  sandbox.fork = async (options = {}) => {
    const fork = fixtureSandbox({ id: `sbx-fork-${++serial}`, name: options.name ?? `fixture-fork-${serial}`, status: "pending" });
    fixtures.push(fork);
    setTimeout(() => { fork.status = "running"; }, 300);
    return fork;
  };
  sandbox.exec = async (command) => {
    const execution = {
      id: `exec-${++serial}`, sandboxId: sandbox.id, command, status: "running", startedAt: new Date(),
      refresh: async function() { return this; },
      cancel: async function() { this.status = "cancelled"; this.finishedAt = new Date(); return this; },
    } as SandboxExec;
    execs.set(sandbox.id, [execution, ...(execs.get(sandbox.id) ?? [])]);
    setTimeout(() => { if (execution.status === "running") { execution.status = "completed"; execution.exitCode = 0; execution.stdout = `fixture output: ${command}\n`; execution.stderr = ""; execution.finishedAt = new Date(); } }, 500);
    return execution;
  };
  sandbox.listExecs = async () => execs.get(sandbox.id) ?? [];
  sandbox.getExec = async (id) => (execs.get(sandbox.id) ?? []).find((execution) => execution.id === id)!;
  Object.defineProperty(sandbox, "processes", { value: {
    start: async (_command: string, options: SandboxProcessStartOptions = {}) => {
      let finish!: (result: SandboxProcessResult) => void;
      const completion = new Promise<SandboxProcessResult>((resolve) => { finish = resolve; });
      queueMicrotask(() => options.onOutput?.({ stream: "stdout", offset: 0, data: new TextEncoder().encode("Fixture shell ready. Type exit or Ctrl+] to return.\r\n") }));
      return {
        id: `process-${++serial}`,
        status: "running",
        stdout: "", stderr: "", cursor: 0, connected: true,
        sendInput: async (input: string | Uint8Array) => {
          const text = typeof input === "string" ? input : new TextDecoder().decode(input);
          if (text.includes("overflow")) {
            const lines = Array.from({ length: 80 }, (_, index) => `OVERFLOW-${String(index + 1).padStart(3, "0")}\r\n`).join("");
            options.onOutput?.({ stream: "stdout", offset: 0, data: new TextEncoder().encode(lines) });
          } else {
            options.onOutput?.({ stream: "stdout", offset: 0, data: new TextEncoder().encode(text) });
          }
          if (text.includes("exit")) finish({ status: "completed", exitCode: 0, stdout: "", stderr: "" });
        },
        resize: async () => {},
        kill: async () => finish({ status: "cancelled", stdout: "", stderr: "" }),
        wait: () => completion,
        disconnect: async () => {},
      };
    },
  } });
  return sandbox;
}

const fixtures: Sandbox[] = [
  fixtureSandbox({ id: "sbx-running", name: "fixture-running", status: "running", runningAt: new Date(now - 3500_000), endpoints: [{ port: 8080, hostname: "fixture.example" }], expiresAt: new Date(now + 3600_000) }),
  fixtureSandbox({ id: "sbx-paused", name: "fixture-paused-with-a-long-name", status: "paused", vcpuCount: 4, memSizeMiB: 8192, baseImage: "ghcr.io/archil/example:long-tag", platform: "amd64", maxConcurrentExecs: 4, lastActiveAt: new Date(now - 60_000) }),
  fixtureSandbox({ id: "sbx-failed", name: "fixture-failed", status: "failed", vcpuCount: 1, memSizeMiB: 512, baseImage: "alpine:latest", maxTtlSeconds: 3600, maxConcurrentExecs: 2, createdAt: new Date(now - 10_800_000), finishedAt: new Date(now - 9000_000), lastActiveAt: new Date(now - 9000_000), exitReason: "fixture failure" }),
];

process.stdout.write("fixture-before\n");
await runSandboxTui({
  service: {
    list: async () => fixtures.filter(({ status }) => status !== "deleted"),
    create: async (request) => {
      const created = fixtureSandbox({ id: `sbx-created-${++serial}`, name: request.name ?? `fixture-created-${serial}`, status: "pending", vcpuCount: request.vcpuCount, memSizeMiB: request.memSizeMiB, baseImage: request.baseImage });
      fixtures.push(created);
      setTimeout(() => { created.status = "running"; }, 300);
      return created;
    },
  },
  profile: "fixture",
  region: "fixture-region",
});
