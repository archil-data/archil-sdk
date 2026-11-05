import type { components } from "@archildata/api-types";
import type { SandboxEgressPolicy } from "./sandbox.js";

/** Network policy for an exec's container, using the sandbox egress rules. */
export type ExecNetwork = Omit<components["schemas"]["ExecNetwork"], "egress"> & {
  egress?: SandboxEgressPolicy;
};

/** The image, size, and network of the VM an exec runs in. */
export type ExecVmOptions = Omit<components["schemas"]["ExecDiskRequest"], "command" | "network"> & {
  network?: ExecNetwork;
};

/**
 * @internal Copies only the known option keys into a request body. Every key
 * is required here, so an option added to the API fails to compile until it is
 * copied.
 */
export function execVmBody(options: ExecVmOptions | undefined): {
  [K in keyof Required<ExecVmOptions>]: ExecVmOptions[K];
} {
  return {
    baseImage: options?.baseImage,
    imageId: options?.imageId,
    vcpuCount: options?.vcpuCount,
    memSizeMib: options?.memSizeMib,
    network: options?.network,
  };
}
