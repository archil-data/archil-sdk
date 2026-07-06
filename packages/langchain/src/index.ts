import { DynamicStructuredTool, tool } from "@langchain/core/tools";
import type { Disk, Workspace } from "disk";
import { AnyBoundSpec, BoundSpec, BoundSpecs, bindSpecs } from "disk/internal/tools";
import z from "zod";

/**
 * Filesystem tools for LangChain / LangGraph. Pass a single {@link Disk} or a
 * {@link Workspace}; returns an array of structured tools ready to bind to a
 * model or hand to a LangGraph agent.
 *
 * ```ts
 * import { createDiskTools } from "disk/langchain";
 * const agent = createReactAgent({ llm, tools: createDiskTools(disk) });
 * ```
 */
type LangchainTool<T> = T extends BoundSpec<infer N, infer S, infer V> ? DynamicStructuredTool<S, z.output<S>, z.input<S>, V, unknown, N> : never;

type CreateLangchainTools<Specs extends readonly AnyBoundSpec[], Accumulator extends LangchainTool<AnyBoundSpec>[]> = Specs extends readonly [infer Head extends AnyBoundSpec, ...infer Tail extends AnyBoundSpec[]]
  ? CreateLangchainTools<Tail, [LangchainTool<Head>, ...Accumulator]>
  : Accumulator;

type LangchainTools = CreateLangchainTools<BoundSpecs, []>;

export function createDiskTools(
  input: Disk | Workspace,
): LangchainTools {
  const bound = bindSpecs(input);
  return bound.map((t) =>
    tool((args: any) => t.invoke(args), {
      name: t.name,
      description: t.description,
      schema: t.schema,
    }),
  ) as LangchainTools;
}
