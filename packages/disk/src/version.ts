// VERSION is injected at build time from package.json's "version" via the
// bundler's `define` (see tsdown.config.ts). CI stamps package.json with the
// release version (`npm version`) before building, so this constant always
// tracks the published version without being hand-maintained — and the bundled,
// browser-targetable output never has to read package.json at runtime.
//
// The fallback only applies to un-injected builds (e.g. a bare `tsc` or a test
// bundle that forgot to pass `define`).
declare const __SDK_VERSION__: string;

export const VERSION: string =
  typeof __SDK_VERSION__ !== "undefined" ? __SDK_VERSION__ : "0.0.0-dev";

// User-Agent sent on every control-plane request, distinct from the Python
// SDK's (archil-python/...) so the control plane can tell the clients apart.
export const USER_AGENT = `archil-js/${VERSION}`;
