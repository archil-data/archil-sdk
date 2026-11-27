import type { components } from "@archildata/api-types";
import { packContext } from "./build-context.js";
import type { ApiClient } from "./client.js";
import { unwrap } from "./client.js";
import { ArchilError, ImageBuildError } from "./errors.js";
import { retryApiRequest } from "./retry.js";

type ImageWire = components["schemas"]["Image"];
type CreateImageWire = components["schemas"]["CreateImageRequest"];

export type ImageStatus = components["schemas"]["ImageState"];

/**
 * Why a build failed. `invalid_source`: the registry reported the image missing
 * or denied access, or the Dockerfile build failed, so retrying won't help.
 * `interrupted`: the build did not finish; requesting it again starts a new build.
 */
export type ImageFailureReason = NonNullable<ImageWire["failure_reason"]>;

export interface Image {
  /** 64-character hex id; pass it to `sandboxes.create({ imageId })`. */
  imageId: string;
  /** Normalized OCI reference. */
  source: string;
  private: boolean;
  status: ImageStatus;
  /** Sandboxes created from the image get this size unless they set their own. */
  vcpuCount: number;
  memSizeMiB: number;
  /** `sha256:` digest of the last successful build, kept while a tag rebuilds. */
  digest?: string;
  /** `repo@sha256:` reference of the last successful build. */
  canonicalSource?: string;
  /** Present only when `status` is `failed`. */
  failureReason?: ImageFailureReason;
  /** The end of a failed Dockerfile build's output. */
  buildLog?: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Registry credentials for a private image. Archil never stores them. */
export type RegistryAuth = components["schemas"]["RegistryAuth"];

export interface BuildImageRequest {
  /** OCI image reference, such as `node:24-bookworm` or `ghcr.io/owner/app@sha256:<digest>`. Set this or `dockerfile`. */
  source?: string;
  /** Required for private images on every build request; without it `source` names the public image. */
  registryAuth?: RegistryAuth;
  /** The text of a Dockerfile to build. Set this or `source`. */
  dockerfile?: string;
  /**
   * Local directory that the Dockerfile's `COPY` and `ADD` read from. It is packed without the
   * paths its `.dockerignore` excludes and uploaded unless the same files were uploaded before.
   */
  context?: string;
  /**
   * Size the build prepares sandboxes to start at from a snapshot; each size of a source is its own image.
   * Defaults to 1 vCPU and 2048 MiB. A sandbox created from the image at another size boots cold.
   */
  vcpuCount?: number;
  memSizeMiB?: number;
}

export interface BuildImageOptions {
  /** Seconds to wait for the build. Defaults to 1800 (30 minutes). */
  timeoutSeconds?: number;
}

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
    buildLog: data.build_log,
    vcpuCount: data.vcpu_count,
    memSizeMiB: data.mem_size_mib,
    createdAt: new Date(data.created_at),
    updatedAt: new Date(data.updated_at),
  };
}

export class Images {
  /** @internal */
  private readonly _client: ApiClient;

  /** @internal */
  constructor(client: ApiClient) {
    this._client = client;
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
   * Build a sandbox image from an OCI reference (`source`) or from the text of a
   * Dockerfile (`dockerfile`), and wait until it is ready. Returns at once when the
   * image is already built from a digest reference or the same Dockerfile and
   * context, and joins a build that is already running. A tag is rebuilt on each
   * call in case it moved, so call this once and reuse `imageId`. Interrupted
   * builds are requested again up to three times; other failures throw
   * {@link ImageBuildError}, whose message ends with a failed Dockerfile build's output.
   */
  async build(request: BuildImageRequest, options: BuildImageOptions = {}): Promise<Image> {
    if ((request.source === undefined) === (request.dockerfile === undefined)) {
      throw new TypeError("Pass either source or dockerfile");
    }
    if (request.context !== undefined && request.dockerfile === undefined) {
      throw new TypeError("context applies only to a dockerfile build");
    }
    if (request.registryAuth !== undefined && request.source === undefined) {
      throw new TypeError("registryAuth applies only to a source build");
    }
    const target = request.dockerfile === undefined
      ? { source: request.source, registry_auth: request.registryAuth }
      : {
        dockerfile: request.dockerfile,
        context: request.context === undefined ? undefined : await this._uploadContext(request.context),
      };
    // Generated types require defaulted fields; omission lets the server choose them.
    const body = { ...target, vcpu_count: request.vcpuCount, mem_size_mib: request.memSizeMiB } as CreateImageWire;
    const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_BUILD_TIMEOUT_SECONDS;
    const deadline = Date.now() + timeoutSeconds * 1000;
    let image = await this._request(body);
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
        image = await this._request(body);
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
      image = await this.get(image.imageId);
      // Requesting a still-building image again joins a healthy build and restarts one whose runtime host is gone.
      if (image.status === "building" && Date.now() - lastRequest >= REQUEST_AGAIN_MS) {
        image = await this._request(body);
        lastRequest = Date.now();
      }
    }
  }

  private async _request(body: CreateImageWire): Promise<Image> {
    const data = await unwrap(retryApiRequest(() => this._client.POST("/api/images", { body }), "transient"));
    return imageFromWire(data);
  }

  /** Packs and uploads `directory` unless the control plane holds the same archive; returns its `sha256:` digest. */
  private async _uploadContext(directory: string): Promise<string> {
    const { data, sha256 } = await packContext(directory);
    const upload = await unwrap(
      retryApiRequest(
        () => this._client.POST("/api/images/contexts", { body: { sha256, size_bytes: data.length } }),
        "transient",
      ),
    );
    if (!upload.present) {
      // The URL carries its own signature, so the API key is not sent with it.
      const response = await fetch(upload.upload_url!, {
        method: "PUT",
        headers: upload.upload_headers as Record<string, string> | undefined,
        body: new Uint8Array(data),
      });
      if (!response.ok) {
        throw new ArchilError(
          `Build context upload failed with HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`,
          response.status,
          "CONTEXT_UPLOAD_FAILED",
        );
      }
    }
    return `sha256:${sha256}`;
  }
}
