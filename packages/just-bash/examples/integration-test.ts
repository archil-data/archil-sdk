/**
 * Integration test: full disk lifecycle through the control plane and mount server.
 *
 * Exercises the complete flow:
 *   1. Create a disk via the control-plane API
 *   2. Mount the disk via disk.mount() (goes through the mount server)
 *   3. Perform file I/O on the mounted disk
 *   4. Delete the disk via the control-plane API
 *
 * Required env vars:
 *   ARCHIL_API_KEY              API key for disk management
 *   ARCHIL_REGION               Region
 *   ARCHIL_BASE_URL             Control-plane API URL
 *   ARCHIL_MOUNT_SERVER         Mount server host:port
 *   ARCHIL_TEST_BUCKET          S3 bucket name for the test disk
 *   AWS_ACCESS_KEY_ID           AWS credentials for the S3 bucket
 *   AWS_SECRET_ACCESS_KEY
 *
 * Optional:
 *   ARCHIL_LOG_LEVEL            Log level for the native client
 *
 * Usage:
 *   ARCHIL_API_KEY=<api-key> \
 *   ARCHIL_REGION=<region> \
 *   ARCHIL_BASE_URL=http://127.0.0.1:8080 \
 *   ARCHIL_MOUNT_SERVER=127.0.0.1:8100 \
 *   ARCHIL_TEST_BUCKET=<test-bucket> \
 *   AWS_ACCESS_KEY_ID=<access-key-id> AWS_SECRET_ACCESS_KEY=<secret-access-key> \
 *   npx tsx examples/integration-test.ts
 */

import { Archil } from "disk";
import { ArchilFs } from "../src/index.js";

function requireEnv(name: string, value: string | undefined): string {
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

const apiKey = requireEnv("ARCHIL_API_KEY", process.env.ARCHIL_API_KEY);
const region = requireEnv("ARCHIL_REGION", process.env.ARCHIL_REGION);
const baseUrl = requireEnv("ARCHIL_BASE_URL", process.env.ARCHIL_BASE_URL);
const mountServer = requireEnv("ARCHIL_MOUNT_SERVER", process.env.ARCHIL_MOUNT_SERVER);
const bucket = requireEnv("ARCHIL_TEST_BUCKET", process.env.ARCHIL_TEST_BUCKET);
const awsAccessKeyId = requireEnv("AWS_ACCESS_KEY_ID", process.env.AWS_ACCESS_KEY_ID);
const awsSecretAccessKey = requireEnv("AWS_SECRET_ACCESS_KEY", process.env.AWS_SECRET_ACCESS_KEY);
const logLevel = process.env.ARCHIL_LOG_LEVEL;

const diskName = `integration-test-${Date.now()}`;
let diskId: string | undefined;

const archil = new Archil({ apiKey, region, baseUrl });

async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
  process.stdout.write(`${label}... `);
  try {
    const result = await fn();
    console.log("ok");
    return result;
  } catch (err) {
    console.log("FAILED");
    throw err;
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForAvailable(diskId: string, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const d = await archil.disks.get(diskId);
    if (d.status === "available") return d;
    if (d.status === "failed" || d.status === "deleted") {
      throw new Error(`Disk reached terminal status: ${d.status}`);
    }
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for disk to become available (${timeoutMs}ms)`);
}

async function main() {
  // 1. Create disk
  let disk = await step("Create disk", async () => {
    const result = await archil.disks.create({
      name: diskName,
      mounts: [
        {
          type: "s3",
          bucketName: bucket,
          accessKeyId: awsAccessKeyId,
          secretAccessKey: awsSecretAccessKey,
        },
      ],
    });
    diskId = result.disk.id;
    return result.disk;
  });

  // 2. Wait for disk to become available
  disk = await step("Wait for disk available", () => waitForAvailable(disk.id));

  // 3. Verify disk appears in list
  await step("Verify disk in list", async () => {
    const disks = await archil.disks.list();
    const found = disks.find((d) => d.id === disk.id);
    assert(!!found, `disk ${disk.id} not found in list`);
  });

  // 4. Register the API key as a token user for mount auth
  await step("Add token user", () =>
    disk.addUser({
      type: "token",
      principal: apiKey,
      nickname: "integration-test",
      tokenSuffix: apiKey.slice(-4),
    }),
  );

  // 5. Mount the disk via the mount server
  const client: any = await step("Mount disk", async () => {
    return disk.mount({
      authToken: apiKey,
      serverAddress: mountServer,
      insecure: true,
      logLevel,
    });
  });

  const fs = await ArchilFs.create(client);
  const ROOT_INODE = 1;

  try {
    await step("Checkout root", () => client.checkout(ROOT_INODE));

    // 4. Write a file
    const testFile = "/integration-test.txt";
    const testContent = `integration test ${Date.now()}`;
    await step("Write file", () => fs.writeFile(testFile, testContent));

    // 5. Read it back and verify
    await step("Read file", async () => {
      const content = await fs.readFile(testFile);
      assert(content === testContent, `content mismatch: got "${content}"`);
    });

    // 6. List root and verify file is present
    await step("List root", async () => {
      const entries = await fs.readdir("/");
      assert(entries.includes("integration-test.txt"), `file not found in root listing: ${entries}`);
    });

    // 7. Clean up the test file
    await step("Remove test file", () => fs.rm(testFile));

    await step("Checkin root", () => client.checkin(ROOT_INODE));
  } finally {
    // 8. Close connection
    await step("Close connection", async () => {
      await client.close();
    });
  }

  // 9. Delete the disk
  await step("Delete disk", () => disk.delete());
  diskId = undefined;

  // 10. Verify disk is gone
  await step("Verify disk deleted", async () => {
    try {
      await archil.disks.get(disk.id);
      assert(false, "expected get to fail after delete, but it succeeded");
    } catch (err: any) {
      assert(
        err.status === 404 || err.message.includes("not found"),
        `unexpected error: ${err.message}`,
      );
    }
  });

  console.log("\nAll steps passed.");
}

main()
  .catch(async (err) => {
    console.error("\nTest failed:", err instanceof Error ? err.message : err);
    if (diskId) {
      console.error(`Cleaning up disk ${diskId}...`);
      try {
        await archil.disks.get(diskId).then((d) => d.delete());
        console.error("Cleaned up.");
      } catch {
        console.error("Cleanup failed — disk may need manual deletion.");
      }
    }
    process.exit(1);
  });
