import { tool, type ToolSet } from "ai";
import type { Disk } from "../../disk.js";
import type { Workspace } from "../../workspace.js";
import { type AgentToolsOptions, bindTools } from "../specs.js";

/**
 * Filesystem tools for the Vercel AI SDK. Pass a single {@link Disk} or a
 * {@link Workspace}; returns a `ToolSet` ready to spread into `generateText`,
 * `streamText`, or an `Agent`'s `tools`.
 *
 * ```ts
 * import { agentTools } from "disk/ai-sdk";
 * const result = await generateText({ model, tools: agentTools(disk), prompt });
 * ```
 */
export function agentTools(input: Disk | Workspace, opts: AgentToolsOptions = {}): ToolSet {
  const bound = bindTools(input, opts.tools);
  const tools: ToolSet = {};
  for (const t of bound) {
    tools[t.name] = tool({
      description: t.description,
      inputSchema: t.schema,
      execute: (args) => t.invoke(args as Record<string, unknown>),
    });
  }
  return tools;
}
