/**
 * @internal Shared agent tool specs for first-party adapter packages.
 *
 * This subpath is not part of Disk's public API; prefer framework subpaths like
 * `disk/ai-sdk` unless you are maintaining an Archil-owned adapter.
 */
export { bindSpecs } from "../agent-tools/specs.js";
export type {
  BoundSpec,
  BoundSpecs,
  ToolErrorResult,
  inferSpecInput,
  inferSpecResult,
} from "../agent-tools/specs.js";
