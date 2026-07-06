# @archildata/mastra

Archil integration for [Mastra](https://mastra.ai/).

## Install

```sh
npm install disk @archildata/mastra
```

`disk` is a peer dependency. The Archil client reads standard Archil environment
configuration, including `ARCHIL_API_KEY` and `ARCHIL_REGION`, unless you pass an existing `Archil`
client.

## Disk Tools

Use `createDiskTools` from an `src/mastra/agents/*.ts` file when the agent should
have direct tools for an Archil disk or multi-disk workspace:

```ts
import { Agent } from "@mastra/core/agent";
import * as archil from "disk";
import { createDiskTools } from "@archildata/mastra";
 
const disk = await archil.getDisk(process.env.ARCHIL_DISK_ID!);
// or mount multiple disks as a workspace...
const disk = archil.workspace({
  source: { disk: await archil.getDisk(process.env.SOURCE_DISK_ID!), readOnly: true },
  reports: await archil.getDisk(process.env.REPORTS_DISK_ID!),
});
 
export const agent = new Agent({
  id: "agent",
  name: "Agent",
  instructions: "Analyze source/sales/**/*.csv, find regional revenue trends, and write a concise report to reports/q2-revenue.md.",
  model: "anthropic/claude-sonnet-5",
  tools: createDiskTools(disk),
});
```
