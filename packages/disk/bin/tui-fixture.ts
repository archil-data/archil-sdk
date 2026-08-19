#!/usr/bin/env node
import type { Sandbox } from "../src/sandbox.js";
import { runSandboxTui } from "../src/tui/run.js";

const now = Date.now();
const fixtures = [
  { id: "sbx-running", name: "fixture-running", status: "running", vcpuCount: 2, memSizeMiB: 2048, baseImage: "ubuntu:26.04", platform: "arm64", maxTtlSeconds: 7200, maxConcurrentExecs: 8, endpoints: [{ port: 8080, hostname: "fixture.example" }], createdAt: new Date(now - 3600_000), runningAt: new Date(now - 3500_000), lastActiveAt: new Date(now - 10_000), expiresAt: new Date(now + 3600_000) },
  { id: "sbx-paused", name: "fixture-paused-with-a-long-name", status: "paused", vcpuCount: 4, memSizeMiB: 8192, baseImage: "ghcr.io/archil/example:long-tag", platform: "amd64", maxTtlSeconds: 7200, maxConcurrentExecs: 4, createdAt: new Date(now - 7200_000), lastActiveAt: new Date(now - 60_000) },
  { id: "sbx-failed", name: "fixture-failed", status: "failed", vcpuCount: 1, memSizeMiB: 512, baseImage: "alpine:latest", maxTtlSeconds: 3600, maxConcurrentExecs: 2, createdAt: new Date(now - 10_800_000), finishedAt: new Date(now - 9000_000), lastActiveAt: new Date(now - 9000_000), exitReason: "fixture failure" },
] as Sandbox[];

process.stdout.write("fixture-before\n");
await runSandboxTui({
  service: { list: async () => fixtures },
  profile: "fixture",
  region: "fixture-region",
});
