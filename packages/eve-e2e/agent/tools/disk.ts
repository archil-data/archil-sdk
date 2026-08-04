import * as archil from "disk";
import { createDiskTools } from "@archildata/eve";

archil.configure({
  apiKey: requireEnv("ARCHIL_API_KEY"),
  region: requireEnv("ARCHIL_REGION"),
  baseUrl: process.env.ARCHIL_BASE_URL,
  s3BaseUrl: process.env.ARCHIL_S3_BASE_URL,
});
const disk = await archil.getDisk(requireEnv("ARCHIL_E2E_DISK_ID"));
export default createDiskTools(disk);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing ${name}; @archildata/eve-e2e requires an Archil test disk.`);
  }
  return value;
}
