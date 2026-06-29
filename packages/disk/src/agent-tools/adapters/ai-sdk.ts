import { tool } from "ai";
import type { Disk } from "../../disk.js";
import type { Workspace } from "../../workspace.js";
import { BoundSpecs, bindSpecs, inferSpecResult } from "../specs.js";
import z from "zod";

/**
 * Filesystem tools for the Vercel AI SDK. Pass a single {@link Disk} or a
 * {@link Workspace}; returns a `ToolSet` ready to spread into `generateText`,
 * `streamText`, or an `Agent`'s `tools`.
 *
 * ```ts
 * import { createDiskTools } from "disk/ai-sdk";
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
