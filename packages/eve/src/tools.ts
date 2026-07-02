import type { Disk, Workspace } from "disk";
import {
  bindSpecs,
  type BoundSpecs,
  type inferSpecInput,
  type inferSpecResult,
  type ToolErrorResult,
} from "disk/internal/tools";
import { defineDynamic, defineTool, type ToolDefinition } from "eve/tools";

export type { ToolErrorResult };

type EveTools = {
  [Spec in BoundSpecs[number] as Spec["name"]]: ToolDefinition<inferSpecInput<Spec>, inferSpecResult<Spec>>;
};

/**
 * Filesystem tools for Eve. Pass a single {@link Disk} or a {@link Workspace};
 * returns a `defineDynamic(...)` export that can be mounted from one
 * `agent/tools/*.ts` file.
 *
 * ```ts
 * import { createDiskTools } from "@archildata/eve";
 * import { disk } from "../lib/archil";
 *
 * export default createDiskTools(disk);
 * ```
 */
export function createDiskTools(input: Disk | Workspace) {
  const toolSpecs = bindSpecs(input);
  const eveTools = Object.fromEntries(toolSpecs.map((spec) => [spec.name, defineTool({
    description: spec.description,
    inputSchema: spec.schema,
    execute: async (args) => spec.invoke(args as any),
  })])) as EveTools;

  const mappedTools = {
    ...eveTools,
    run_bash: undefined,
    bash: {
      ...eveTools.run_bash,
      name: "bash",
    },
  }
  delete mappedTools.run_bash;

  return defineDynamic({
    events: {
      "session.started": () => mappedTools,
    },
  });
}
