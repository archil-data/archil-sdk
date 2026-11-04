import type { SandboxEgressPolicy } from "./sandbox.js";

/** Network policy for an exec's container, using the sandbox egress rules. */
export interface ExecNetwork {
  /** Egress policy. Egress is unrestricted when omitted. */
  egress?: SandboxEgressPolicy;
}

/** The image, size, and network of the VM an exec runs in. */
export interface ExecVmOptions {
  /**
   * Public Linux OCI image reference to run the command in, such as
   * `python:3.12-slim`. The first exec with an image waits while it is
   * converted; later execs reuse it. Defaults to Archil's exec image.
   * Cannot be combined with `imageId`.
   */
  baseImage?: string;
  /**
   * Ready image from `images.build()`, for images that need registry
   * credentials. Cannot be combined with `baseImage`.
   */
  imageId?: string;
  /**
   * vCPUs for the VM, from 1 to 32. Defaults to 2. An exec larger than the
   * default size (2 vCPUs, 4096 MiB) bills as that many multiples of a call.
   */
  vcpuCount?: number;
  /** Memory in MiB for the VM, from 256 to 65536. Defaults to 4096. */
  memSizeMib?: number;
  /** Network policy. Free plans cannot set one. */
  network?: ExecNetwork;
}

/** @internal The request fields for `options`, leaving out the unset ones. */
export function execVmBody(options: ExecVmOptions | undefined): ExecVmOptions {
  const body: ExecVmOptions = {};
  if (options?.baseImage !== undefined) body.baseImage = options.baseImage;
  if (options?.imageId !== undefined) body.imageId = options.imageId;
  if (options?.vcpuCount !== undefined) body.vcpuCount = options.vcpuCount;
  if (options?.memSizeMib !== undefined) body.memSizeMib = options.memSizeMib;
  if (options?.network !== undefined) body.network = options.network;
  return body;
}
