import { createTool } from "@mastra/core/tools";
import type { Disk } from "../../disk.js";
import type { Workspace } from "../../workspace.js";
import { type AgentToolsOptions, bindTools } from "../specs.js";

type MastraTool = ReturnType<typeof createTool>;

/**
 * Filesystem tools for Mastra. Pass a single {@link Disk} or a
 * {@link Workspace}; returns a record of tools keyed by id, ready to drop into
 * an `Agent`'s `tools`.
 *
 * ```ts
 * import { agentTools } from "disk/mastra";
 * const agent = new Agent({ name, model, tools: agentTools(workspace) });
 * ```
 */
export function agentTools(input: Disk | Workspace, opts: AgentToolsOptions = {}): Record<string, MastraTool> {
  const bound = bindTools(input, opts.tools);
  const tools: Record<string, MastraTool> = {};
  for (const t of bound) {
    tools[t.name] = createTool({
      id: t.name,
      description: t.description,
      inputSchema: t.schema,
      // Mastra passes the validated input on `ctx.context`; tolerate versions
      // that hand the input object directly as the first argument.
      execute: async (ctx) => {
        const input =
          ctx && typeof ctx === "object" && "context" in ctx
            ? (ctx as { context: unknown }).context
            : ctx;
        return t.invoke(input as Record<string, unknown>);
      },
    });
  }
  return tools;
}
