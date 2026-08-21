import type { Sandbox } from "../sandbox.js";
import { renderTable } from "./output.js";

export type OutputFormat = "table" | "json";

export function parseOutputFormat(value: string): OutputFormat {
  if (value !== "table" && value !== "json") {
    throw new Error("Output format must be 'table' or 'json'");
  }
  return value;
}

function date(value: Date | undefined): string {
  return value?.toISOString() ?? "";
}

export function sortSandboxes(sandboxes: Sandbox[]): Sandbox[] {
  return [...sandboxes].sort((left, right) => {
    const activity = right.lastActiveAt.getTime() - left.lastActiveAt.getTime();
    return activity || left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
  });
}

export function formatSandboxList(sandboxes: Sandbox[], format: OutputFormat): string {
  const ordered = sortSandboxes(sandboxes);
  if (format === "json") return JSON.stringify(ordered, null, 2);
  if (ordered.length === 0) return "No sandboxes found.";
  return renderTable(
    ordered.map((sandbox) => [
      sandbox.id,
      sandbox.name,
      sandbox.status,
      String(sandbox.vcpuCount),
      `${sandbox.memSizeMiB} MiB`,
      sandbox.baseImage,
      date(sandbox.lastActiveAt),
      date(sandbox.expiresAt),
    ]),
    ["id", "name", "status", "cpu", "memory", "image", "last active", "expires"],
  );
}

export function formatSandbox(sandbox: Sandbox, format: OutputFormat): string {
  if (format === "json") return JSON.stringify(sandbox, null, 2);
  const rows: string[][] = [
    ["id", sandbox.id],
    ["name", sandbox.name],
    ["status", sandbox.status],
    ["cpu", String(sandbox.vcpuCount)],
    ["memory", `${sandbox.memSizeMiB} MiB`],
    ["image", sandbox.baseImage],
    ["platform", sandbox.platform ?? ""],
    ["max TTL", `${sandbox.maxTtlSeconds} seconds`],
    ["max concurrent processes", String(sandbox.maxConcurrentExecs)],
    ["created", date(sandbox.createdAt)],
    ["running", date(sandbox.runningAt)],
    ["finished", date(sandbox.finishedAt)],
    ["last active", date(sandbox.lastActiveAt)],
    ["expires", date(sandbox.expiresAt)],
    ["exit reason", sandbox.exitReason ?? ""],
  ];
  for (const endpoint of sandbox.endpoints ?? []) {
    rows.push([`endpoint ${endpoint.port}`, endpoint.hostname]);
  }
  return renderTable(rows.filter(([, value]) => value !== ""));
}
