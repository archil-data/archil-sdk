import type { components } from "@archildata/api-types";
import type { ApiClient } from "./client.js";
import { unwrap } from "./client.js";
import { ImageBuildError } from "./errors.js";
import { retryApiRequest } from "./retry.js";

type ImageWire = components["schemas"]["Image"];

export type ImageStatus = components["schemas"]["ImageState"];

export interface RegistryAuth {
  username: string;
  /** Password or access token, such as a GitHub token with `read:packages` for ghcr.io. */
  password: string;
}

export interface CreateImageRequest {
  /**
   * Linux OCI image reference. Docker Hub shorthand and tags are accepted,
   * e.g. `node:24-bookworm` or `ghcr.io/owner/app:v2`.
   */
  source: string;
  /**
   * Credentials for a private registry. They are used only while this image
   * builds and are never returned, and the image is visible only to your account.
   */
  registryAuth?: RegistryAuth;
}

export interface ImageWaitOptions {
  /** Wait until the image is ready. Defaults to true. */
  wait?: boolean;
}

export interface Image {
  id: string;
  /** Normalized OCI reference the image is pulled from. */
  source: string;
  /** Whether the image is pulled with registry credentials. */
  private: boolean;
  status: ImageStatus;
  /** Set once ready. Pass the image, or this digest, when creating a sandbox. */
  digest?: string;
  /** The manifest the source resolved to, as `repository@sha256:...`. */
  canonicalSource?: string;
  failureReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const POLL_INTERVAL_MS = 1_000;

function fromWire(wire: ImageWire): Image {
  return {
    id: wire.image_id,
    source: wire.source,
    private: wire.private,
    status: wire.status,
    digest: wire.digest,
    canonicalSource: wire.canonical_source,
    failureReason: wire.failure_reason,
    createdAt: new Date(wire.created_at),
    updatedAt: new Date(wire.updated_at),
  };
}

export class Images {
  /** @internal */
  private readonly _client: ApiClient;

  /** @internal */
  constructor(client: ApiClient) {
    this._client = client;
  }

  /**
   * Build an image that sandboxes can boot, from a public or private registry.
   * Requesting a source that is already building joins that build. By default
   * this waits until the image is ready and throws {@link ImageBuildError} if
   * the build fails.
   */
  async create(request: CreateImageRequest, options: ImageWaitOptions = {}): Promise<Image> {
    const body = {
      source: request.source,
      registry_auth: request.registryAuth,
    };
    const data = await unwrap(
      retryApiRequest(
        () => this._client.POST("/api/images", { body }),
        "transient",
      ),
    );
    const image = fromWire(data as ImageWire);
    return options.wait === false ? image : this._waitForBuild(image);
  }

  /** Fetch an image's current build status. */
  async get(id: string): Promise<Image> {
    const data = await unwrap(
      retryApiRequest(
        () => this._client.GET("/api/images/{image_id}", { params: { path: { image_id: id } } }),
        "transient",
      ),
    );
    return fromWire(data as ImageWire);
  }

  /** @internal */
  private async _waitForBuild(image: Image): Promise<Image> {
    while (image.status === "building") {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      image = await this.get(image.id);
    }
    if (image.status === "failed") throw new ImageBuildError(image);
    return image;
  }
}
