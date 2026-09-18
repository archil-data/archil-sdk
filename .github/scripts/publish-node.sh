#!/usr/bin/env bash
set -e

# Keep an empty report when the build fails before Changesets runs.
: > "$CHANGESETS_OUTPUT"
publish_status=0
pnpm release || publish_status=$?

# The Changesets action creates remote tags and releases from these events.
node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";

const reportPath = process.env.CHANGESETS_OUTPUT;
const events = readFileSync(reportPath, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));

writeFileSync(
  reportPath,
  events
    .map((event) => JSON.stringify({ ...event, tag: `npm/${event.tag}` }) + "\n")
    .join(""),
);
NODE

# Successfully published packages still get tagged if another package failed.
exit "$publish_status"
