# archil-sdk

This repository contains SDKs for using Archil. It currently contains:

- [`disk`](./packages/disk/README.md) - A client for using Archil disks.
- [`@archildata/sqlite`](./packages/sqlite/README.md) - Run serverless SQLite databases on Archil disks.
- [`archil`](./packages/python/README.md) - Pure-Python SDK for disks, serverless execution, object access, workspaces, and agent tools. Its low-level `archil.openapi` client is generated from the canonical `api/controlplane/openapi.yaml` in the `archil-data/archil` repository. Regenerate it with `pnpm generate:python` from a checkout next to `archil` (requires [uv](https://docs.astral.sh/uv/)).
