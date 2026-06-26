const REGION_URLS: Record<string, string> = {
  "aws-us-east-1": "https://control.green.us-east-1.aws.prod.archil.com",
  "aws-us-west-2": "https://control.green.us-west-2.aws.prod.archil.com",
  "aws-eu-west-1": "https://control.green.eu-west-1.aws.prod.archil.com",
  "gcp-us-central1": "https://control.blue.us-central1.gcp.prod.archil.com",
};

export function resolveBaseUrl(region: string): string {
  const url = REGION_URLS[region];
  if (!url) {
    throw new Error(
      `Unknown region "${region}". Valid regions: ${Object.keys(REGION_URLS).join(", ")}`,
    );
  }
  return url;
}

/**
 * Derive the S3-compatible endpoint from a control-plane base URL by swapping a
 * leading `control.` hostname segment for `s3.` (e.g.
 * `control.green.us-east-1.…` → `s3.green.us-east-1.…`). Returns undefined if the
 * URL can't be parsed. A host without a `control.` prefix is returned unchanged.
 */
export function deriveS3BaseUrl(controlBaseUrl: string): string | undefined {
  try {
    const u = new URL(controlBaseUrl);
    u.hostname = u.hostname.replace(/^control\./, "s3.");
    return u.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}
