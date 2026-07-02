import * as archil from "disk";
import { createDiskTools } from "@archildata/eve";

const disk = await archil.getDisk(requireEnv("ARCHIL_E2E_DISK_ID"));
export default createDiskTools(disk);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing ${name}; @archildata/eve-e2e requires an Archil test disk.`);
  }
  return value;
}
