import type { components } from "@archildata/api-types";
import type { SandboxEgressPolicy } from "./sandbox.js";

/** Network policy for an exec's container, using the sandbox egress rules. */
export type ExecNetwork = Omit<components["schemas"]["ExecNetwork"], "egress"> & {
  egress?: SandboxEgressPolicy;
};

/** The image, size, and network of the VM an exec runs in. */
export type ExecVmOptions = Omit<
  components["schemas"]["ExecDiskRequest"],
  "command" | "network" | "timeoutSeconds" | "async"
> & {
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

/**
 * @internal A REST exec request body. The generated types require its
 * server-defaulted `timeoutSeconds` and `async`; the SDK leaves both to the
 * server, so they are not sent.
 */
export function restExecBody<T>(body: Omit<T, "timeoutSeconds" | "async">): T {
  return body as T;
}

/**
 * @internal A REST exec response as the SDK returns it: the completed result.
 * The API's `202` hand-off for a command still running after the request's
 * wait is not handled yet.
 */
export function completedExec<T>(
  response: Promise<unknown>,
): Promise<{ data?: { success: boolean; data?: T; error?: string }; error?: unknown; response: Response }> {
  return response as Promise<{ data?: { success: boolean; data?: T; error?: string }; error?: unknown; response: Response }>;
}
