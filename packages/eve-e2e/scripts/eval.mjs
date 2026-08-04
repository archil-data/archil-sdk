import { spawn } from "node:child_process";
import { Archil } from "disk";

const archil = new Archil({
  apiKey: process.env.ARCHIL_API_KEY,
  region: process.env.ARCHIL_REGION,
  baseUrl: process.env.ARCHIL_BASE_URL,
  s3BaseUrl: process.env.ARCHIL_S3_BASE_URL,
});
const diskName = `eve-e2e-${process.env.GITHUB_RUN_ID ?? Date.now()}-${process.env.GITHUB_RUN_ATTEMPT ?? process.pid}`;

let disk;
let exitCode = 1;

try {
  ({ disk } = await archil.disks.create({ name: diskName }));

  const child = spawn("eve", ["eval", ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, ARCHIL_E2E_DISK_ID: disk.id },
  });
  exitCode = await new Promise((resolve) => child.on("exit", (code) => resolve(code ?? 1)));
} finally {
  if (disk) {
    await disk.delete();
  }
}

process.exitCode = exitCode;
