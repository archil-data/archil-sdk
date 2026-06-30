# @archildata/eve

Archil integration for [eve](https://www.npmjs.com/package/eve).

This package provides different functionality depending on your use case.

If you want to provide your agent with access to existing data in an Archil disk use `createDiskTools`, an eve toolset factory exposing standard filesystem capabilities as tools.

If you want a sandbox backed by an Archil disk and serverless execution use `archilBackend`.

## Install

```sh
npm install @archildata/eve disk
```

`disk` is a peer dependency. The Archil client reads standard Archil environment
configuration, including `ARCHIL_API_KEY` and `ARCHIL_REGION`, unless you pass an existing `Archil`
client.

## Disk Tools

Use `createDiskTools` from an eve `agent/tools/*.ts` file when the agent should
have direct tools for an Archil disk or multi-disk workspace:

```ts
// agent/tools/filesystem.ts
import * as archil from "disk";
import { createDiskTools } from "@archildata/eve";

const disk = await archil.getDisk(process.env.ARCHIL_DISK_ID!);
export default createDiskTools(disk);
```

For multiple disks, pass a workspace:

```ts
import * as archil from "disk";
import { createDiskTools } from "@archildata/eve";

const archil = new Archil();
const workspace = archil.workspace({
  app: await archil.getDisk(process.env.ARCHIL_APP_DISK_ID!),
  data: await archil.getDisk(process.env.ARCHIL_DATA_DISK_ID!),
});

export default createDiskTools(workspace);
```

`createDiskTools` returns an eve `defineDynamic(...)` export that is ready to
mount from one tools file.

## Sandbox Backend

Use `archilBackend` from an eve sandbox definition:

```ts
// agent/sandbox/sandbox.ts
import { archilBackend } from "@archildata/eve";
import { defineSandbox } from "eve/sandbox";

export default defineSandbox({
  backend: archilBackend({
    disk: process.env.ARCHIL_DISK_ID!,
  }),
});
```

Set `ARCHIL_DISK_ID` to the ID of the Archil disk that should back the sandbox.

`archilBackend` accepts:

- `disk`: Archil disk ID.
- `client`: Existing Archil client. Omit this to create one from environment
  configuration.
- `rootPrefix`: Namespace for this eve app on the disk. Defaults to `.eve/sandbox`.
- `queueMs`: Archil write queue timeout. Defaults to `5000`.

Use eve's normal bootstrap hook when the sandbox should start with
project-specific files or tools:

```ts
export default defineSandbox({
  backend: archilBackend({
    disk: process.env.ARCHIL_DISK_ID!,
  }),
  revalidationKey: () => "python-tools-v1",
  async bootstrap({ use }) {
    const sandbox = await use();
    await sandbox.run({ command: "mkdir -p .cache && python --version" });
  },
});
```
