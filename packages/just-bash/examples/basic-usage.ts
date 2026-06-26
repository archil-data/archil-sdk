/**
 * Basic usage example for @archil/just-bash
 *
 * This example demonstrates using the Archil filesystem adapter with just-bash
 * to run shell commands against an Archil distributed filesystem.
 *
 * Usage:
 *   ARCHIL_REGION=aws-us-east-1 ARCHIL_DISK=myaccount/mydisk npx ts-node examples/basic-usage.ts
 */

import { ArchilClient } from "@archildata/native";
import { ArchilFs } from "../src/index.js";

async function main() {
  const region = process.env.ARCHIL_REGION;
  const diskName = process.env.ARCHIL_DISK;

  if (!region || !diskName) {
    console.error("Usage: ARCHIL_REGION=<region> ARCHIL_DISK=<disk> npx ts-node examples/basic-usage.ts");
    console.error("");
    console.error("Example:");
    console.error("  ARCHIL_REGION=aws-us-east-1 ARCHIL_DISK=myaccount/mydisk npx ts-node examples/basic-usage.ts");
    process.exit(1);
  }

  console.log(`Connecting to Archil: region=${region}, disk=${diskName}`);

  // Connect to Archil
  const client = await ArchilClient.connect({
    region,
    diskName,
  });

  console.log("Connected successfully!");

  // Create filesystem adapter
  const fs = await ArchilFs.create(client);

  // Demo: List root directory
  console.log("\n--- Listing root directory ---");
  const rootEntries = await fs.readdir("/");
  console.log("Root entries:", rootEntries);

  // Demo: Read a file (if it exists)
  console.log("\n--- Testing file operations ---");

  const testFile = "/archil-just-bash-test.txt";
  const testContent = `Hello from archil-just-bash!\nTimestamp: ${new Date().toISOString()}`;

  // Write a test file
  console.log(`Writing to ${testFile}...`);
  await fs.writeFile(testFile, testContent);
  console.log("Write successful!");

  // Read it back
  console.log(`Reading ${testFile}...`);
  const readContent = await fs.readFile(testFile);
  console.log("Content:", readContent);

  // Get file stats
  console.log(`Getting stats for ${testFile}...`);
  const stats = await fs.stat(testFile);
  console.log("Stats:", {
    isFile: stats.isFile,
    isDirectory: stats.isDirectory,
    size: stats.size,
    mode: stats.mode.toString(8),
  });

  // Demo: Create a directory
  console.log("\n--- Testing directory operations ---");
  const testDir = "/archil-just-bash-test-dir";

  if (await fs.exists(testDir)) {
    console.log(`${testDir} already exists, removing...`);
    await fs.rm(testDir, { recursive: true });
  }

  console.log(`Creating ${testDir}...`);
  await fs.mkdir(testDir);
  console.log("Directory created!");

  // Write a file in the new directory
  const nestedFile = `${testDir}/nested-file.txt`;
  console.log(`Writing ${nestedFile}...`);
  await fs.writeFile(nestedFile, "Nested file content");

  // List the directory
  console.log(`Listing ${testDir}...`);
  const dirEntries = await fs.readdirWithFileTypes(testDir);
  for (const entry of dirEntries) {
    console.log(`  ${entry.name} (file=${entry.isFile}, dir=${entry.isDirectory})`);
  }

  // Cleanup
  console.log("\n--- Cleanup ---");
  console.log(`Removing ${testFile}...`);
  await fs.rm(testFile);
  console.log(`Removing ${testDir}...`);
  await fs.rm(testDir, { recursive: true });
  console.log("Cleanup complete!");

  // Close the client
  await client.close();
  console.log("\nDone!");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
