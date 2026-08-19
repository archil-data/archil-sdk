import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { SandboxModelSnapshot } from "../model.js";
import { safeCell } from "./sandbox-table.js";
import { bold, cyan, dim, statusColor } from "./theme.js";

export class SandboxDetails implements Component {
  constructor(private readonly getSnapshot: () => SandboxModelSnapshot) {}

  render(width: number): string[] {
    const sandbox = this.getSnapshot().selected;
    if (!sandbox) return [dim(truncateToWidth("Select a sandbox to inspect it.", width))];
    const values: Array<[string, unknown]> = [
      ["ID", sandbox.id],
      ["Name", sandbox.name],
      ["Status", sandbox.status],
      ["Platform", sandbox.platform ?? "-"],
      ["Created", sandbox.createdAt.toISOString()],
      ["Running", sandbox.runningAt?.toISOString() ?? "-"],
      ["Finished", sandbox.finishedAt?.toISOString() ?? "-"],
      ["Last active", sandbox.lastActiveAt.toISOString()],
      ["Expires", sandbox.expiresAt?.toISOString() ?? "-"],
      ["Max TTL", `${sandbox.maxTtlSeconds}s`],
      ["Max execs", sandbox.maxConcurrentExecs],
      ["Endpoints", sandbox.endpoints?.map(({ port, hostname }) => `${port}: ${hostname}`).join(", ") || "-"],
      ["Exit reason", sandbox.exitReason ?? "-"],
    ];
    return [
      bold(cyan("DETAILS")),
      dim("─".repeat(width)),
      ...values.map(([label, value]) => {
        const line = `${cyan(label.padEnd(12))} ${safeCell(value)}`;
        return truncateToWidth(label === "Status" ? `${cyan(label.padEnd(12))} ${statusColor(String(value), safeCell(value))}` : line, width, "…");
      }),
    ];
  }

  invalidate(): void {}
}
