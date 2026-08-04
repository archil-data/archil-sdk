# Release workflows

The JavaScript SDKs are released with [Changesets](https://github.com/changesets/changesets). Versioning and publishing are fully automated by CI — nobody runs `npm publish` from their machine for a normal release.

## Overview

1. When you open a PR that changes a package's public behavior, add a changeset describing the change and the semver bump.
2. When PRs land on `main`, the [Node Release workflow](../.github/workflows/node-release.yaml) collects pending changesets into a **"Version Packages"** PR that bumps versions and updates changelogs.
3. When that Version Packages PR is merged, the same workflow builds everything and publishes the bumped packages to npm.

## Adding a changeset to your PR

From the repo root:

```sh
pnpm changeset
```

Pick the package(s) your change affects, choose a bump type (`patch`, `minor`, or `major`), and write a short summary — it becomes the changelog entry. Commit the generated file in `.changeset/` with your PR.

Skip the changeset for changes that don't affect published packages (CI config, docs, tests, private packages) or only affect internals (refactoring, optimization).

## What CI does (`.github/workflows/node-release.yaml`)

The **Node Release** workflow runs when Node package or Changesets files change on `main` (one run at a time per branch, via a concurrency group). It uses [`changesets/action`](https://github.com/changesets/action), which does one of two things:

- **Pending changesets exist** → it opens or updates the **Version Packages** PR. That PR consumes the changeset files, bumps `package.json` versions, and updates each package's `CHANGELOG.md`. It stays open and keeps absorbing new changesets until someone merges it.
- **No pending changesets** (i.e., the Version Packages PR was just merged) → it runs `pnpm release`, which is `pnpm build && changeset publish`. Only packages whose local version is ahead of npm get published, and each gets a git tag.

Publishing authenticates via [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC, the `id-token: write` permission) — there is no long-lived npm token in the publish step.

## Cutting a release, step by step

1. Land your PRs (each with a changeset) on `main`.
2. Wait for the Release workflow to open/update the **Version Packages** PR and review it — check the version bumps and changelog entries.
3. Merge the Version Packages PR.
4. The Release workflow runs again, builds all packages, and publishes the bumped ones to npm.

## Publishing a brand-new package (`node-initial-release.yaml`)

`changeset publish` can't publish a package that has never existed on npm because it compares the package version in the repository to the public version on npm to determine if it needs a release. For first-time publishes, use the **Initial Node Release** workflow ([`.github/workflows/node-initial-release.yaml`](../.github/workflows/node-initial-release.yaml)):

1. In GitHub Actions, run **Initial Node Release** via *workflow dispatch*.
2. Pass the package name(s) to publish, space-separated, in the `packages` input (e.g. `@archildata/sqlite`).
3. The workflow builds the repository and publishes the initial version of each package specified.

After the initial version exists on npm, configure trusted publishing for the package on npmjs.com and let the normal changesets flow handle all subsequent releases.

## Publishing the Python SDK

The `archil` Python package has an independent release workflow:

1. Update `python/pyproject.toml` and `python/CHANGELOG.md` in a release PR.
2. Merge the release PR to `main`.
3. Tag that commit as `python/vX.Y.Z`, matching the version in `pyproject.toml`.
4. The [Python release workflow](../.github/workflows/python-release.yaml) verifies the tag, runs the complete Python test suite, builds the wheel and source distribution, publishes them to PyPI with trusted publishing, and creates a GitHub release.

The first release from this repository is `python/v0.8.27`. PyPI trusted
publishing for the `archil` project must point to `archil-data/archil-sdk`,
workflow `python-release.yaml`, environment `pypi`. The old publisher in
`archil-data/archil` is disabled.

## Troubleshooting

- **My change merged but no Version Packages PR appeared** — the PR probably didn't include a changeset. Open a follow-up PR that adds one (`pnpm changeset`).
- **A package didn't publish** — `changeset publish` only publishes packages whose version in `package.json` is newer than the latest on npm. Confirm the Version Packages PR actually bumped it.
- **First-time publish fails in the normal workflow** — use the Initial Node Release workflow (see above), then set up trusted publishing for the new package.
