import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import type { Disk } from "../../disk.js";
import type { Workspace } from "../../workspace.js";
import { type AgentToolsOptions, bindTools } from "../specs.js";

/**
 * Filesystem tools for LangChain / LangGraph. Pass a single {@link Disk} or a
 * {@link Workspace}; returns an array of structured tools ready to bind to a
 * model or hand to a LangGraph agent.
 *
 * ```ts
 * import { agentTools } from "disk/langchain";
 * const agent = createReactAgent({ llm, tools: agentTools(disk) });
 * ```
 */
export function agentTools(
  input: Disk | Workspace,
  opts: AgentToolsOptions = {},
): StructuredToolInterface[] {
  const bound = bindTools(input, opts.tools);
  return bound.map((t) =>
    tool((args: Record<string, unknown>) => t.invoke(args), {
      name: t.name,
      description: t.description,
      schema: t.schema,
    }),
  );
}
