import type { ApiClient } from "./client.js";
import { unwrap } from "./client.js";
import { ArchilError, ImageBuildError } from "./errors.js";
import { retryApiRequest } from "./retry.js";

export type ImageStatus = "building" | "ready" | "failed";

/**
 * Why a build failed. `invalid_source`: the registry reported the image missing
 * or denied access, so retrying won't help. `interrupted`: the build did not
 * finish; requesting it again starts a new build.
 */
export type ImageFailureReason = "invalid_source" | "interrupted";

export interface Image {
  /** 64-character hex id; pass it to `sandboxes.create({ imageId })`. */
  imageId: string;
  /** Normalized OCI reference. */
  source: string;
  private: boolean;
  status: ImageStatus;
  /** `sha256:` digest of the last successful build, kept while a tag rebuilds. */
  digest?: string;
  /** `repo@sha256:` reference of the last successful build. */
  canonicalSource?: string;
  /** Present only when `status` is `failed`. */
  failureReason?: ImageFailureReason;
  createdAt: Date;
  updatedAt: Date;
}

/** Registry credentials for a private image. Archil never stores them. */
export interface RegistryAuth {
  username: string;
  password: string;
}

export interface BuildImageRequest {
  /** OCI image reference, such as `node:24-bookworm` or `ghcr.io/owner/app@sha256:<digest>`. */
  source: string;
  /** Required for private images on every build request; without it `source` names the public image. */
  registryAuth?: RegistryAuth;
}

export interface BuildImageOptions {
  /** Seconds to wait for the build. Defaults to 1800 (30 minutes). */
  timeoutSeconds?: number;
}

interface ImageWire {
  image_id: string;
  source: string;
  private: boolean;
  status: ImageStatus;
  digest?: string;
  canonical_source?: string;
  failure_reason?: ImageFailureReason;
  created_at: string;
  updated_at: string;
}

type ImageResponse = Promise<{
  data?: { success: boolean; data?: ImageWire; error?: string };
  error?: unknown;
  response: Response;
}>;

type ImagesClient = {
  POST(
    path: "/api/images",
    options: { body: { source: string; registry_auth?: RegistryAuth } },
  ): ImageResponse;
  GET(
    path: "/api/images/{image_id}",
    options: { params: { path: { image_id: string } } },
  ): ImageResponse;
};

const DEFAULT_BUILD_TIMEOUT_SECONDS = 30 * 60;
const MAX_INTERRUPTED_RETRIES = 3;
const REQUEST_AGAIN_MS = 2 * 60_000;
const FIRST_POLL_MS = 1_000;
const MAX_POLL_MS = 5_000;

function imageFromWire(data: ImageWire): Image {
  return {
    imageId: data.image_id,
    source: data.source,
    private: data.private,
    status: data.status,
    digest: data.digest,
    canonicalSource: data.canonical_source,
    failureReason: data.failure_reason,
    createdAt: new Date(data.created_at),
    updatedAt: new Date(data.updated_at),
  };
}

export class Images {
  /** @internal */
  private readonly _client: ImagesClient;

  /** @internal */
  constructor(client: ApiClient) {
    // The endpoints are newer than the minimum @archildata/api-types version.
    this._client = client as unknown as ImagesClient;
  }

  async get(imageId: string): Promise<Image> {
    const data = await unwrap(
      retryApiRequest(
        () => this._client.GET("/api/images/{image_id}", { params: { path: { image_id: imageId } } }),
        "transient",
      ),
    );
    return imageFromWire(data);
  }

  /**
   * Build a sandbox image from an OCI reference and wait until it is ready.
   * Returns at once when the image is already built from a digest reference
   * and joins a build that is already running. A tag is rebuilt on each call
   * in case it moved, so call this once and reuse `imageId`. Interrupted
   * builds are requested again up to three times; other failures throw
   * {@link ImageBuildError}.
   */
  async build(request: BuildImageRequest, options: BuildImageOptions = {}): Promise<Image> {
    const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_BUILD_TIMEOUT_SECONDS;
    const deadline = Date.now() + timeoutSeconds * 1000;
    let image = await this._request(request);
    let lastRequest = Date.now();
    let retries = 0;
    let pollMs = FIRST_POLL_MS;
    for (;;) {
      if (image.status === "ready") return image;
      if (image.status === "failed") {
        if (image.failureReason !== "interrupted" || retries >= MAX_INTERRUPTED_RETRIES) {
          throw new ImageBuildError(image);
        }
        retries++;
        image = await this._request(request);
        lastRequest = Date.now();
        continue;
      }
      if (Date.now() >= deadline) {
        throw new ArchilError(
          `Image ${image.imageId} was not ready after ${timeoutSeconds} seconds`,
          408,
          "IMAGE_BUILD_TIMEOUT",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      pollMs = Math.min(pollMs * 2, MAX_POLL_MS);
      // Requesting again joins a healthy build and restarts one whose runtime host is gone.
      if (Date.now() - lastRequest >= REQUEST_AGAIN_MS) {
        image = await this._request(request);
        lastRequest = Date.now();
      } else {
        image = await this.get(image.imageId);
      }
    }
  }

  private async _request(request: BuildImageRequest): Promise<Image> {
    const data = await unwrap(
      retryApiRequest(
        () =>
          this._client.POST("/api/images", {
            body: { source: request.source, registry_auth: request.registryAuth },
          }),
        "transient",
      ),
    );
    return imageFromWire(data);
  }
}
