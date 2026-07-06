import { tool } from "ai";
import type { Disk, Workspace } from "disk";
import { BoundSpecs, bindSpecs, inferSpecResult } from "disk/internal/tools";
import z from "zod";

/**
 * Filesystem tools for the Vercel AI SDK. Pass a single {@link Disk} or a
 * {@link Workspace}; returns a `ToolSet` ready to spread into `generateText`,
 * `streamText`, or an `Agent`'s `tools`.
 *
 * ```ts
 * import { createDiskTools } from "@archildata/ai-sdk";
 * const result = await generateText({ model, tools: createDiskTools(disk), prompt });
 * ```
 */
type AISDKTools = {
  [Spec in BoundSpecs[number] as Spec["name"]]: {
    description: Spec["description"];
    inputSchema: Spec["schema"],
    execute: (args: z.infer<Spec["schema"]>) => Promise<inferSpecResult<Spec>>;
  }
}

export function createDiskTools(input: Disk | Workspace) {
  const toolSpecs = bindSpecs(input);
  return Object.fromEntries(toolSpecs.map((spec) => [spec.name, tool({
    description: spec.description,
    inputSchema: spec.schema as any,
    execute: spec.invoke as any,
  })])) as unknown as AISDKTools;
}
