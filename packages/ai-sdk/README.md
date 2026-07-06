# @archildata/ai-sdk

Archil integration for [AI SDK](https://ai-sdk.dev/).

## Install

```sh
npm install disk @archildata/ai-sdk
```

`disk` is a peer dependency. The Archil client reads standard Archil environment
configuration, including `ARCHIL_API_KEY` and `ARCHIL_REGION`, unless you pass an existing `Archil`
client.

## Disk Tools

Use `createDiskTools` when the agent should have direct tools for an Archil disk or multi-disk workspace:

```ts
import * as archil from "disk";
import { createDiskTools } from "@archildata/ai-sdk";

const disk = await archil.getDisk(process.env.ARCHIL_DISK_ID!);
// or mount multiple disks as a workspace...
const disk = archil.workspace({
  source: { disk: await archil.getDisk(process.env.SOURCE_DISK_ID!), readOnly: true },
  reports: await archil.getDisk(process.env.REPORTS_DISK_ID!),
});
 
const { text } = await generateText({
  model: "anthropic/claude-sonnet-5",
  tools: createDiskTools(disk),
  prompt: "Analyze source/sales/**/*.csv, find regional revenue trends, and write a concise report to reports/q2-revenue.md.",
});
```
