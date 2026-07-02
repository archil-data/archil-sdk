# Archil Eve E2E Fixture

This private package is an Eve eval fixture for the `@archildata/eve` `createDiskTools` integration.

It reuses a configured Archil test disk and isolates fixture state under an Eve-specific root prefix. The eval uses a real Eve agent model and asks the agent to complete a multi-turn disk task through the Eve filesystem tools created by `createDiskTools`.

This fixture intentionally fails loudly when the Archil disk configuration is missing. It should not skip Archil tool coverage.

Run locally:

```sh
pnpm run build

ARCHIL_API_KEY=... \
ARCHIL_REGION=... \
AI_GATEWAY_API_KEY=... \
ARCHIL_E2E_DISK_ID=... \
pnpm --filter @archildata/eve-e2e eval
```

Optional env:

- `ARCHIL_BASE_URL`: control-plane override used by `disk`.
- `ARCHIL_S3_BASE_URL`: S3 endpoint override used by `disk`.
- `ARCHIL_E2E_ROOT_PREFIX`: disk prefix for fixture state. Defaults to a local unique prefix.
- `EVE_E2E_MODEL`: gateway model id. Defaults to `openai/gpt-5.4-nano`.

For local runs, provide either `AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN` for the real model call. Against a deployed target, pass `-- --url <target>` and configure these credentials in the deployment.

Pass Eve eval flags after `--`, for example:

```sh
pnpm --filter @archildata/eve-e2e eval -- --url https://your-eve-app.example
```

GitHub Actions runs the eval on every push to `main` and from manual `workflow_dispatch`.
Configure these repository secrets:

- `AI_GATEWAY_API_KEY`
- `ARCHIL_API_KEY`
- `ARCHIL_REGION`
- `ARCHIL_E2E_DISK_ID`
