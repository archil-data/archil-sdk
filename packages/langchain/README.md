# @archildata/langchain

Archil integration for [LangChain](https://www.langchain.com/).

## Install

```sh
npm install disk @archildata/langchain
```

`disk` is a peer dependency. The Archil client reads standard Archil environment
configuration, including `ARCHIL_API_KEY` and `ARCHIL_REGION`, unless you pass an existing `Archil`
client.

## Disk Tools

Use `createDiskTools` when the agent should have direct tools for an Archil disk or multi-disk workspace:

```ts
import { createAgent } from "langchain";
import * as archil from "disk";
import { createDiskTools } from "disk/langchain";
 
const disk = await archil.getDisk(process.env.ARCHIL_DISK_ID!);
// or mount multiple disks as a workspace...
const disk = archil.workspace({
  source: { disk: await archil.getDisk(process.env.SOURCE_DISK_ID!), readOnly: true },
  reports: await archil.getDisk(process.env.REPORTS_DISK_ID!),
});
 
const agent = createAgent({
  model: "claude-sonnet-5",
  tools: createDiskTools(disk),
});
```
