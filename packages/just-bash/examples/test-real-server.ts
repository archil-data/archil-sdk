/**
 * Test script to validate the adapter against a real Archil server.
 *
 * Usage:
 *   ARCHIL_REGION=<region> ARCHIL_DISK=<disk> ARCHIL_DISK_TOKEN=<token> npx tsx examples/test-real-server.ts
 *
 * Region formats:
 *   - Public region id, e.g. "aws-us-east-1"
 *   - Custom deployment slug for non-public environments
 *
 * Example:
 *   ARCHIL_REGION=... ARCHIL_DISK=myaccount/mydisk ARCHIL_DISK_TOKEN=adt_xxx npx tsx examples/test-real-server.ts
 */

import { ArchilClient } from "@archildata/native";
import { ArchilFs } from "../src/index.js";

async function main() {
  const region = process.env.ARCHIL_REGION;
  const diskName = process.env.ARCHIL_DISK;
  const authToken = process.env.ARCHIL_DISK_TOKEN;

  if (!region || !diskName) {
    console.error("Missing required environment variables.");
    console.error("");
    console.error("Usage:");
    console.error("  ARCHIL_REGION=<region> ARCHIL_DISK=<disk> [ARCHIL_DISK_TOKEN=<token>] npx tsx examples/test-real-server.ts");
    console.error("");
    console.error("Region formats:");
    console.error('  - Public region id, e.g. "aws-us-east-1"');
    console.error("  - Custom deployment slug for non-public environments");
    process.exit(1);
  }

  console.log(`Connecting to Archil: region=${region}, disk=${diskName}${authToken ? ", token=<redacted>" : " (using IAM)"}`);

  // Connect to Archil
  const client = await ArchilClient.connect({
    region,
    diskName,
    authToken,
  });

  console.log("Connected successfully!");

  // Create filesystem adapter
  const fs = await ArchilFs.create(client);

  // Test 1: List root directory
  console.log("\n--- Test 1: List root directory ---");
  try {
    const rootEntries = await fs.readdir("/");
    console.log("Root entries:", rootEntries);
  } catch (err) {
    console.error("Error listing root:", err);
  }

  // Test 2: Get stats for root
  console.log("\n--- Test 2: Stat root ---");
  try {
    const stats = await fs.stat("/");
    console.log("Root stats:", {
      isFile: stats.isFile,
      isDirectory: stats.isDirectory,
      size: stats.size,
      mode: stats.mode.toString(8),
    });
  } catch (err) {
    console.error("Error stat root:", err);
  }

  // Test 3: Write and read a test file
  console.log("\n--- Test 3: Write and read test file ---");
  const testFile = "/archil-just-bash-test.txt";
  const testContent = `Hello from archil-just-bash!\nTimestamp: ${new Date().toISOString()}`;

  try {
    console.log(`Writing to ${testFile}...`);
    await fs.writeFile(testFile, testContent);
    console.log("Write successful!");

    console.log(`Reading ${testFile}...`);
    const readContent = await fs.readFile(testFile);
    console.log("Content:", readContent);

    // Cleanup
    console.log(`Removing ${testFile}...`);
    await fs.rm(testFile);
    console.log("Removed!");
  } catch (err) {
    console.error("Error with write/read:", err);
  }

  // Test 4: Create directory
  console.log("\n--- Test 4: Create and list directory ---");
  const testDir = "/archil-test-dir";

  try {
    // Clean up if exists
    if (await fs.exists(testDir)) {
      console.log(`${testDir} exists, removing first...`);
      await fs.rm(testDir, { recursive: true });
    }

    console.log(`Creating ${testDir}...`);
    await fs.mkdir(testDir);
    console.log("Created!");

    console.log(`Listing ${testDir}...`);
    const entries = await fs.readdir(testDir);
    console.log("Entries:", entries);

    // Create a file in the directory
    const nestedFile = `${testDir}/test.txt`;
    console.log(`Writing ${nestedFile}...`);
    await fs.writeFile(nestedFile, "nested content");

    console.log(`Listing ${testDir} after file creation...`);
    const entriesAfter = await fs.readdirWithFileTypes(testDir);
    for (const entry of entriesAfter) {
      console.log(`  ${entry.name} (file=${entry.isFile}, dir=${entry.isDirectory})`);
    }

    // Cleanup
    console.log(`Removing ${testDir}...`);
    await fs.rm(testDir, { recursive: true });
    console.log("Removed!");
  } catch (err) {
    console.error("Error with directory:", err);
  }

  // Close the client
  await client.close();
  console.log("\nAll tests complete!");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
