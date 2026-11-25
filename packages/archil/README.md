# archil

The `archil` command-line tool for [Archil](https://archil.com) disks and sandboxes, and an
alias for [`disk`](https://www.npmjs.com/package/disk), the TypeScript SDK.

```bash
npx archil sandbox create my-desk --desktop
npx archil sandbox desktop my-desk
npx archil disk list
```

See the [`disk` README](https://www.npmjs.com/package/disk#cli) for the full CLI. As a
library, `archil` re-exports everything from `disk`: `import { Archil } from "archil"`
behaves exactly like `import { Archil } from "disk"`. New projects should depend on `disk`
directly. See [docs.archil.com](https://docs.archil.com) for documentation.
