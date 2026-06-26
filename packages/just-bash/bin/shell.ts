#!/usr/bin/env node
/**
 * Interactive just-bash shell with Archil filesystem
 *
 * Quick start with S3 bucket:
 *   npx @archildata/just-bash s3://my-bucket --api-key adt_xxx
 *
 * Traditional usage:
 *   npx @archildata/just-bash aws-us-east-1 myaccount/mydisk
 *   npx @archildata/just-bash --region aws-us-east-1 --disk myaccount/mydisk
 */

import * as readline from "readline";
import { Command } from "commander";
import { ArchilClient } from "@archildata/native";
import { Archil, Disk } from "disk";
import { Bash } from "just-bash";
import { ArchilFs, createArchilCommand } from "../src/index.js";

const program = new Command();

program
  .name("archil-shell")
  .description("Interactive bash shell with Archil filesystem")
  .version("0.1.0")
  .argument("[target]", "S3 bucket (s3://bucket) or region (e.g., aws-us-east-1)")
  .argument("[disk]", "Disk name (e.g., myaccount/mydisk) - only when target is region")
  .option("-r, --region <region>", "Region identifier (e.g., aws-us-east-1)")
  .option("-d, --disk <disk>", "Disk name (e.g., myaccount/mydisk)")
  .option("-k, --api-key <key>", "API key for disk management (required for S3 bucket mode)")
  .option("-t, --token <token>", "Auth token for direct connection (defaults to IAM)")
  .option("-l, --log-level <level>", "Log level: trace, debug, info, warn, error")
  .option("--bucket-region <region>", "AWS region for the S3 bucket (default: us-east-1)")
  .option("--bucket-prefix <prefix>", "Path prefix within the bucket")
  .addHelpText("after", `
Quick Start (S3 bucket mode):
  Connect directly to an S3 bucket - creates a disk if needed:
  $ npx @archildata/just-bash s3://my-bucket --api-key adt_xxx
  $ npx @archildata/just-bash s3://my-bucket --api-key adt_xxx --bucket-region us-west-2

  AWS credentials are read from environment:
  $ AWS_ACCESS_KEY_ID=xxx AWS_SECRET_ACCESS_KEY=xxx npx @archildata/just-bash s3://my-bucket -k adt_xxx

Traditional usage (direct connection):
  $ npx @archildata/just-bash aws-us-east-1 myaccount/mydisk
  $ npx @archildata/just-bash --region aws-us-east-1 --disk myaccount/mydisk
  $ ARCHIL_DISK_TOKEN=xxx npx @archildata/just-bash aws-us-east-1 myaccount/mydisk

Subdirectory mounting (mount a subdirectory as the root):
  $ npx @archildata/just-bash aws-us-east-1 myaccount/mydisk:/data/project

Environment variables:
  ARCHIL_API_KEY    API key for disk management
  ARCHIL_REGION     Fallback for --region
  ARCHIL_DISK       Fallback for --disk
  ARCHIL_DISK_TOKEN      Fallback for --token (recommended for secrets)
  ARCHIL_LOG_LEVEL  Fallback for --log-level
  AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY  S3 credentials for bucket mode
`);

program.parse();

const opts = program.opts();
const args = program.args;

// Check if first argument is an S3 bucket
const isS3Bucket = args[0]?.startsWith("s3://");

/**
 * Parse S3 bucket URL
 */
function parseS3Url(url: string): { bucket: string; prefix?: string } {
  const match = url.match(/^s3:\/\/([^/]+)(\/.*)?$/);
  if (!match) {
    throw new Error(`Invalid S3 URL: ${url}`);
  }
  return {
    bucket: match[1],
    prefix: match[2]?.slice(1) || undefined, // Remove leading /
  };
}

/**
 * Generate a disk name from an S3 bucket
 */
function diskNameFromBucket(bucket: string): string {
  // Sanitize bucket name for use as disk name (alphanumeric, hyphens, underscores)
  return `s3-${bucket.replace(/[^a-zA-Z0-9-]/g, "-")}`;
}

/**
 * Find an existing disk that mounts the given S3 bucket
 */
function findDiskForBucket(disks: Disk[], bucketName: string): Disk | undefined {
  return disks.find((disk) =>
    disk.mounts?.some(
      (mount) =>
        mount.type === "s3" &&
        mount.config?.bucketName === bucketName
    )
  );
}

/**
 * S3 bucket quick-start mode
 */
async function runS3BucketMode() {
  const s3Url = args[0];
  const logLevel = opts.logLevel || process.env.ARCHIL_LOG_LEVEL;
  const region = opts.region || process.env.ARCHIL_REGION || "aws-us-east-1";
  const bucketRegion = opts.bucketRegion || "us-east-1";

  // Check for AWS credentials
  const awsAccessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const awsSecretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

  if (!awsAccessKeyId || !awsSecretAccessKey) {
    console.error("Error: AWS credentials required for S3 bucket mode");
    console.error("");
    console.error("Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables:");
    console.error("  AWS_ACCESS_KEY_ID=xxx AWS_SECRET_ACCESS_KEY=xxx npx @archildata/just-bash s3://my-bucket -k adt_xxx");
    process.exit(1);
  }

  const { bucket, prefix } = parseS3Url(s3Url);
  const combinedPrefix = opts.bucketPrefix
    ? opts.bucketPrefix + (prefix ? "/" + prefix : "")
    : prefix;

  console.log("Archil S3 Quick Start");
  console.log("=====================");
  console.log(`  Bucket: ${bucket}`);
  if (combinedPrefix) {
    console.log(`  Prefix: ${combinedPrefix}`);
  }
  console.log(`  Region: ${region}`);
  console.log(`  Bucket Region: ${bucketRegion}`);
  console.log("");

  // Initialize Archil control plane client
  // apiKey falls back to ARCHIL_API_KEY env var via the Archil constructor
  let archil: Archil;
  try {
    archil = new Archil({
      apiKey: opts.apiKey,
      region,
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    console.error("");
    console.error("Usage:");
    console.error("  npx @archildata/just-bash s3://my-bucket --api-key adt_xxx");
    console.error("");
    console.error("Or set ARCHIL_API_KEY environment variable:");
    console.error("  ARCHIL_API_KEY=adt_xxx npx @archildata/just-bash s3://my-bucket");
    process.exit(1);
  }

  // Check if a disk for this bucket already exists
  console.log("Checking for existing disk...");
  let disk: Disk | undefined;
  let mountToken: string | undefined;

  try {
    const disks = await archil.disks.list();
    disk = findDiskForBucket(disks, bucket);

    if (disk) {
      console.log(`Found existing disk: ${disk.name} (${disk.id})`);
    }
  } catch (err) {
    console.error("Failed to list disks:", err instanceof Error ? err.message : err);
    process.exit(1);
  }

  // Create disk if it doesn't exist
  if (!disk) {
    const diskName = diskNameFromBucket(bucket);
    console.log(`Creating new disk: ${diskName}`);

    try {
      const result = await archil.disks.create({
        name: diskName,
        mounts: [
          {
            type: "s3",
            bucketName: bucket,
            bucketPrefix: combinedPrefix,
            accessKeyId: awsAccessKeyId,
            secretAccessKey: awsSecretAccessKey,
          },
        ],
      });
      disk = result.disk;
      mountToken = result.token ?? undefined;
      console.log(`Created disk: ${disk.name} (${disk.id})`);
    } catch (err) {
      console.error("Failed to create disk:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
  }

  // For existing disks, generate a fresh mount token
  if (!mountToken) {
    try {
      const { token } = await disk.createToken("just-bash");
      mountToken = token;
    } catch (err) {
      console.error("Failed to create mount token:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
  }

  // Connect to the disk
  console.log("Connecting...");
  let client: ArchilClient;
  try {
    client = await disk.mount({ authToken: mountToken, logLevel }) as ArchilClient;
    console.log("Connected!");
  } catch (err) {
    console.error("Failed to connect:", err instanceof Error ? err.message : err);
    process.exit(1);
  }

  return { client, diskName: disk.name, subdirectory: undefined as string | undefined };
}

/**
 * Traditional direct connection mode
 */
async function runDirectMode() {
  const region = args[0] || opts.region || process.env.ARCHIL_REGION;
  const rawDisk = args[1] || opts.disk || process.env.ARCHIL_DISK;
  const authToken = opts.token || process.env.ARCHIL_DISK_TOKEN;
  const logLevel = opts.logLevel || process.env.ARCHIL_LOG_LEVEL;

  // Parse disk:/subdirectory syntax (e.g., "myaccount/mydisk:/data/project")
  // Uses ":/" delimiter to match NFS convention where paths are always absolute.
  let diskName: string | undefined;
  let subdirectory: string | undefined;
  if (rawDisk) {
    const colonIdx = rawDisk.indexOf(":/");
    if (colonIdx !== -1) {
      diskName = rawDisk.substring(0, colonIdx);
      const subdir = rawDisk.substring(colonIdx + 1).replace(/^\/+|\/+$/g, "");
      if (subdir) {
        subdirectory = subdir;
      }
    } else {
      diskName = rawDisk;
    }
  }

  if (!region || !diskName) {
    console.error("Error: region and disk are required\n");
    console.error("Usage:");
    console.error("  npx @archildata/just-bash <region> <disk>");
    console.error("  npx @archildata/just-bash --region <region> --disk <disk>");
    console.error("\nQuick start with S3 bucket:");
    console.error("  npx @archildata/just-bash s3://my-bucket --api-key adt_xxx");
    console.error("\nExamples:");
    console.error("  npx @archildata/just-bash aws-us-east-1 myaccount/mydisk");
    console.error("  ARCHIL_DISK_TOKEN=xxx npx @archildata/just-bash aws-us-east-1 myaccount/mydisk");
    console.error("\nRun with --help for more options.");
    process.exit(1);
  }

  console.log("Connecting to Archil...");
  console.log(`  Region: ${region}`);
  console.log(`  Disk: ${diskName}`);
  if (subdirectory) {
    console.log(`  Subdirectory: ${subdirectory}`);
  }
  console.log(`  Auth: ${authToken ? "token" : "IAM"}`);
  if (logLevel) {
    console.log(`  Log level: ${logLevel}`);
  }
  console.log("");

  let client: ArchilClient;
  try {
    client = await ArchilClient.connect({
      region,
      diskName,
      authToken: authToken || undefined,
      logLevel,
    });
    console.log("Connected!");
  } catch (err) {
    console.error("Failed to connect:", err instanceof Error ? err.message : err);
    process.exit(1);
  }

  return { client, diskName, subdirectory };
}

async function main() {
  // Determine which mode to run
  const { client, diskName, subdirectory } = isS3Bucket
    ? await runS3BucketMode()
    : await runDirectMode();

  // Create filesystem adapter (resolves subdirectory eagerly if specified)
  const fs = await ArchilFs.create(client, { subdirectory });

  // Create bash environment with archil delegation commands
  const bash = new Bash({ fs, customCommands: [createArchilCommand(client, fs)] });

  // Cleanup function to release delegations and close connection
  let cleaningUp = false;
  const cleanup = async (signal?: string) => {
    if (cleaningUp) return;
    cleaningUp = true;

    if (signal) {
      console.log(`\nReceived ${signal}, cleaning up...`);
    } else {
      console.log("\nGoodbye!");
    }

    try {
      // close() releases all delegations and cleans up resources
      const released = await client.close();
      if (released > 0) {
        console.log(`Released ${released} delegation${released > 1 ? "s" : ""}`);
      }
    } catch (err) {
      console.error("Error during cleanup:", err instanceof Error ? err.message : err);
    }

    process.exit(0);
  };

  // Handle signals for graceful shutdown
  process.on("SIGINT", () => cleanup("SIGINT"));
  process.on("SIGTERM", () => cleanup("SIGTERM"));
  process.on("SIGHUP", () => cleanup("SIGHUP"));

  console.log("");
  console.log("=== Archil just-bash shell ===");
  console.log(`Connected to: ${diskName}${subdirectory ? ":" + subdirectory : ""}`);
  console.log("");
  console.log("Type bash commands to interact with the filesystem.");
  console.log("Special commands:");
  console.log("  archil checkout [--force] <path>  - Acquire write delegation");
  console.log("  archil checkin <path>             - Release write delegation");
  console.log("  archil list-delegations           - Show held delegations");
  console.log("  archil help                       - Show archil commands");
  console.log("Type 'exit' or Ctrl+D to quit.");
  console.log("");

  // Create readline interface for interactive input
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "archil$ ",
  });

  let cwd = "/";

  const prompt = () => {
    rl.setPrompt(`archil:${cwd}$ `);
    rl.prompt();
  };

  prompt();

  rl.on("line", async (line) => {
    const trimmed = line.trim();

    if (trimmed === "exit" || trimmed === "quit") {
      await cleanup();
      return;
    }

    if (!trimmed) {
      prompt();
      return;
    }

    // Pause readline while we process the command
    rl.pause();

    try {
      const result = await bash.exec(trimmed, {
        cwd,
        env: {
          HOME: "/",
          USER: "archil",
          PWD: cwd,
        },
      });

      // Print output
      if (result.stdout) {
        process.stdout.write(result.stdout);
        if (!result.stdout.endsWith("\n")) {
          console.log("");
        }
      }
      if (result.stderr) {
        process.stderr.write(result.stderr);
        if (!result.stderr.endsWith("\n")) {
          console.error("");
        }
      }

      // Update cwd if command changed it
      if (result.env?.PWD && result.env.PWD !== cwd) {
        cwd = result.env.PWD;
      }
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : err);
    }

    rl.resume();
    prompt();
  });

  rl.on("close", () => cleanup());
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
