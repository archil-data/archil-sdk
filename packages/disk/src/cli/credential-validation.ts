import { Archil } from "../archil.js";
import { REGION_URLS } from "../regions.js";
import { validateApiKey } from "./credentials.js";

export interface CredentialValidationOptions {
  apiKey: string;
  region?: string;
  baseUrl?: string;
}

type CredentialProbe = (options: { apiKey: string; region: string; baseUrl?: string }) => Promise<void>;

export async function validateCredentialAndResolveRegion(
  options: CredentialValidationOptions,
  probe: CredentialProbe = async ({ apiKey, region, baseUrl }) => {
    await new Archil({ apiKey, region, baseUrl }).disks.list({ limit: 1 });
  },
): Promise<string> {
  const apiKey = validateApiKey(options.apiKey);
  if (options.region) {
    await probe({ ...options, apiKey, region: options.region });
    return options.region;
  }
  if (options.baseUrl) {
    throw new Error("Profile creation with --base-url also requires --region because custom environments cannot be auto-detected");
  }

  const failures: unknown[] = [];
  for (const region of Object.keys(REGION_URLS)) {
    try {
      await probe({ apiKey, region });
      return region;
    } catch (error) {
      failures.push(error);
    }
  }
  throw new AggregateError(failures, "API key was not accepted in any known production region; pass --region for a custom environment");
}
