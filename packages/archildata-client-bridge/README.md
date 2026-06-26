# @archildata/client (deprecated)

This package has been renamed and split. Please migrate:

- For the pure-JS API client and CLI: install [`disk`](https://www.npmjs.com/package/disk).
- For low-level native protocol access (rarely needed — most users want `disk exec` or the `archil` CLI): install [`@archildata/native`](https://www.npmjs.com/package/@archildata/native).

```ts
// before
import { Archil, ArchilClient } from "@archildata/client";

// after
import { Archil } from "disk";
import { ArchilClient } from "@archildata/native";
```

This 0.2.x release is a one-time compatibility shim that re-exports both packages so existing imports keep working. It will receive no further updates.
