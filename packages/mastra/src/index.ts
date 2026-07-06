import { createTool, Tool } from "@mastra/core/tools";
import type { Disk, Workspace } from "disk";
import { BoundSpecs, bindSpecs, inferSpecResult } from "disk/internal/tools";
import z from "zod";

type MastraTool = ReturnType<typeof createTool>;

type MastraTools = {
  [Spec in BoundSpecs[number] as Spec["name"]]: Tool<z.infer<Spec["schema"]>, inferSpecResult<Spec>>;
}

/**
 * Filesystem tools for Mastra. Pass a single {@link Disk} or a
 * {@link Workspace}; returns a record of tools keyed by id, ready to drop into
 * an `Agent`'s `tools`.
 *
 * ```ts
 * import { createDiskTools } from "@archildata/mastra";
 * const agent = new Agent({ name, model, tools: createDiskTools(workspace) });
 * ```
 */
export function createDiskTools(input: Disk | Workspace): MastraTools {
  const bound = bindSpecs(input);
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
        return t.invoke(input as any);
      },
    });
  }
  return tools as MastraTools;
}
