import type { SandboxProcessStartOptions } from "../sandbox-process.js";
import type { CreateSandboxRequest } from "../sandboxes.js";

export interface CreateSandboxCliOptions {
  vcpuCount?: string;
  memSizeMib?: string;
  baseImage?: string;
  maxTtlSeconds?: string;
  maxConcurrentProcesses?: string;
  env: string[];
}

export function validateSandboxName(name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  const value = name.trim();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)) {
    throw new Error("Name must be 1–63 lowercase letters, numbers, or hyphens and cannot start or end with a hyphen");
  }
  return value;
}

function optionalInteger(value: string | undefined, label: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

export function parseEnvironment(entries: string[]): Record<string, string> | undefined {
  if (entries.length === 0) return undefined;
  const environment: Record<string, string> = {};
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator <= 0) throw new Error(`Invalid environment entry '${entry}'; use NAME=value`);
    const name = entry.slice(0, separator);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Invalid environment variable name '${name}'`);
    }
    environment[name] = entry.slice(separator + 1);
  }
  return environment;
}

export function parseCreateSandboxOptions(name: string | undefined, options: CreateSandboxCliOptions): CreateSandboxRequest {
  return {
    name: validateSandboxName(name),
    vcpuCount: optionalInteger(options.vcpuCount, "CPU count", 1, 32),
    memSizeMiB: optionalInteger(options.memSizeMib, "Memory", 256, 65_536),
    baseImage: options.baseImage,
    maxTtlSeconds: optionalInteger(options.maxTtlSeconds, "Max TTL", 1, 2_147_483_647),
    maxConcurrentExecs: optionalInteger(options.maxConcurrentProcesses, "Max concurrent processes", 1, 1024),
    env: parseEnvironment(options.env),
  };
}

export function parseRunOptions(options: { env: string[]; timeout?: string }): Pick<SandboxProcessStartOptions, "env" | "timeoutSeconds"> {
  return {
    env: parseEnvironment(options.env),
    timeoutSeconds: optionalInteger(options.timeout, "Timeout", 1, 2_147_483_647),
  };
}
