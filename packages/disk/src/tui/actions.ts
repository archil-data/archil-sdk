import type { CreateSandboxRequest, SandboxPortMapping } from "../sandboxes.js";
import type { SandboxStatus } from "../sandbox.js";

export type SandboxAction = "start" | "pause" | "resume" | "stop" | "fork" | "delete";

export const ACTIONS_BY_STATUS: Readonly<Record<SandboxStatus, readonly SandboxAction[]>> = {
  running: ["pause", "stop", "fork"],
  paused: ["resume", "start", "stop", "fork"],
  stopped: ["start", "fork", "delete"],
  exited: ["start", "delete"],
  failed: ["start", "delete"],
  pending: [],
  pausing: [],
  stopping: [],
  deleting: [],
  deleted: [],
};

export interface CreateSandboxForm {
  name: string;
  vcpuCount: string;
  memSizeMiB: string;
  baseImage: string;
  maxTtlSeconds: string;
  maxConcurrentExecs: string;
  portMappings: string;
  env: string;
}

function optionalInteger(value: string, label: string, min: number, max: number): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${label} must be an integer from ${min} to ${max}`);
  return parsed;
}

export function parseCreateSandboxForm(form: CreateSandboxForm): CreateSandboxRequest {
  const name = form.name.trim();
  if (name && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) {
    throw new Error("Name must be 1–63 lowercase letters, numbers, or hyphens and cannot start or end with a hyphen");
  }
  const portMappings: SandboxPortMapping[] = form.portMappings.trim() ? form.portMappings.split(",").map((entry) => {
    const match = entry.trim().match(/^(\d+)(?:\/(tcp|udp))?$/);
    if (!match) throw new Error(`Invalid port mapping '${entry.trim()}'; use PORT/tcp or PORT/udp`);
    const containerPort = Number(match[1]);
    if (containerPort < 1 || containerPort > 65535) throw new Error("Port mappings must use ports from 1 to 65535");
    return { containerPort, protocol: (match[2] ?? "tcp") as "tcp" | "udp" };
  }) : [];
  const env: Record<string, string> = {};
  if (form.env.trim()) {
    for (const entry of form.env.split(",")) {
      const separator = entry.indexOf("=");
      if (separator <= 0) throw new Error(`Invalid environment entry '${entry.trim()}'; use NAME=value`);
      const key = entry.slice(0, separator).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment variable name '${key}'`);
      env[key] = entry.slice(separator + 1);
    }
  }
  return {
    name: name || undefined,
    vcpuCount: optionalInteger(form.vcpuCount, "CPU count", 1, 32),
    memSizeMiB: optionalInteger(form.memSizeMiB, "Memory", 256, 65_536),
    baseImage: form.baseImage.trim() || "ubuntu:26.04",
    maxTtlSeconds: optionalInteger(form.maxTtlSeconds, "Max TTL", 1, 2_147_483_647),
    maxConcurrentExecs: optionalInteger(form.maxConcurrentExecs, "Max concurrent execs", 1, 1024),
    portMappings: portMappings.length ? portMappings : undefined,
    env: Object.keys(env).length ? env : undefined,
  };
}
