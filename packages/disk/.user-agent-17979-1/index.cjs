Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
//#region \0rolldown/runtime.js
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
		key = keys[i];
		if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
			get: ((k) => from[k]).bind(null, key),
			enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
		});
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));
//#endregion
let openapi_fetch = require("openapi-fetch");
openapi_fetch = __toESM(openapi_fetch, 1);
let fast_xml_parser = require("fast-xml-parser");
let _bufbuild_protobuf = require("@bufbuild/protobuf");
let _archildata_api_types_process = require("@archildata/api-types/process");
//#region src/s3xml.ts
const parser = new fast_xml_parser.XMLParser({
	isArray: (name) => name === "Contents" || name === "CommonPrefixes",
	parseTagValue: false,
	trimValues: true,
	ignoreAttributes: true
});
/** Parse an XML document into a plain object. Returns {} for empty/blank input. */
function parseXml(xml) {
	if (!xml.trim()) return {};
	return parser.parse(xml);
}
//#endregion
//#region src/errors.ts
/**
* Base class for every error the SDK throws. Catch with `instanceof ArchilError`
* to handle control-plane and S3 failures uniformly; `status` is the HTTP status
* code and `code` a machine-readable error code when the server provided one.
*/
var ArchilError = class extends Error {
	/** HTTP status code associated with the failure. */
	status;
	/** Machine-readable error code (e.g. an S3 code like "NoSuchKey"), if known. */
	code;
	constructor(message, status, code) {
		super(message);
		this.name = "ArchilError";
		this.status = status;
		this.code = code;
	}
};
/** Error from the control-plane REST API. */
var ArchilApiError = class extends ArchilError {
	constructor(message, status, code) {
		super(message, status, code);
		this.name = "ArchilApiError";
	}
};
var SandboxPauseError = class extends ArchilError {
	latest;
	constructor(latest) {
		super(`Sandbox entered ${latest.status} before it paused${latest.exitReason ? `: ${latest.exitReason}` : ""}`, 409, "SANDBOX_PAUSE_FAILED");
		this.latest = latest;
		this.name = "SandboxPauseError";
	}
};
var ImageBuildError = class extends ArchilError {
	latest;
	reason;
	constructor(latest) {
		super(`Image ${latest.imageId} build failed: ${latest.failureReason}`, 409, "IMAGE_BUILD_FAILED");
		this.latest = latest;
		this.name = "ImageBuildError";
		this.reason = latest.failureReason;
	}
};
var SandboxFileTransferError = class extends ArchilError {
	operation;
	path;
	constructor(operation, path, cause) {
		super(`Sandbox file ${operation} failed for ${path}: ${cause.message}`, 500, "SANDBOX_FILE_TRANSFER_FAILED");
		this.name = "SandboxFileTransferError";
		this.operation = operation;
		this.path = path;
		this.cause = cause;
	}
};
/**
* Error from the S3-compatible object API (getObject/putObject/deleteObject/
* headObject/listObjects). The gateway returns an S3-style XML `<Error>` body;
* this surfaces its parts as structured fields (`status`, `code`, `requestId`)
* rather than a raw blob, while keeping the full body on `raw` for debugging.
*/
var ArchilS3Error = class extends ArchilError {
	/** S3 request id, if the gateway returned one. */
	requestId;
	/** Raw response body (the XML document), for debugging. */
	raw;
	constructor(opts) {
		const detail = opts.message ?? opts.statusText ?? "";
		const codePart = opts.code ? ` ${opts.code}` : "";
		super(`S3 ${opts.operation} failed: ${opts.statusCode}${codePart}${detail ? ` — ${detail}` : ""}`, opts.statusCode, opts.code);
		this.name = "ArchilS3Error";
		this.requestId = opts.requestId;
		this.raw = opts.raw;
	}
};
function tagString(obj, tag) {
	const value = obj[tag];
	return value === void 0 || value === null ? void 0 : String(value);
}
/** Build an ArchilS3Error from a failed S3 response, parsing the XML body. */
function parseS3Error(operation, statusCode, statusText, body) {
	let err = {};
	try {
		err = parseXml(body).Error ?? {};
	} catch {
		err = {};
	}
	return new ArchilS3Error({
		operation,
		statusCode,
		statusText,
		code: tagString(err, "Code"),
		message: tagString(err, "Message"),
		requestId: tagString(err, "RequestId"),
		raw: body
	});
}
//#endregion
//#region src/regions.ts
const REGION_URLS = {
	"aws-us-east-1": "https://control.green.us-east-1.aws.prod.archil.com",
	"aws-us-west-2": "https://control.green.us-west-2.aws.prod.archil.com",
	"aws-eu-west-1": "https://control.green.eu-west-1.aws.prod.archil.com",
	"gcp-us-central1": "https://control.blue.us-central1.gcp.prod.archil.com"
};
function resolveBaseUrl(region) {
	const url = REGION_URLS[region];
	if (!url) throw new Error(`Unknown region "${region}". Valid regions: ${Object.keys(REGION_URLS).join(", ")}`);
	return url;
}
/**
* Derive the S3-compatible endpoint from a control-plane base URL by swapping a
* leading `control.` hostname segment for `s3.` (e.g.
* `control.green.us-east-1.…` → `s3.green.us-east-1.…`). Returns undefined if the
* URL can't be parsed. A host without a `control.` prefix is returned unchanged.
*/
function deriveS3BaseUrl(controlBaseUrl) {
	try {
		const u = new URL(controlBaseUrl);
		u.hostname = u.hostname.replace(/^control\./, "s3.");
		return u.toString().replace(/\/$/, "");
	} catch {
		return;
	}
}
//#endregion
//#region src/version.ts
const VERSION = "1.9.0";
const USER_AGENT = `archil-js/${VERSION}`;
//#endregion
//#region src/client.ts
const createClient = typeof openapi_fetch.default === "function" ? openapi_fetch.default : openapi_fetch.default.default;
function isNodeRuntime() {
	return typeof process !== "undefined" && typeof process.versions?.node === "string";
}
const undiciModule = isNodeRuntime() ? import("undici") : void 0;
const CONTROL_PLANE_CONNECTIONS = 1;
const IDLE_SESSION_TIMEOUT_MS = 3e4;
function isAsyncIterableBody(body) {
	return body != null && typeof body === "object" && Symbol.asyncIterator in body;
}
async function bufferBody(body) {
	const chunks = [];
	for await (const chunk of body) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
	return Buffer.concat(chunks);
}
const bufferRequestBodies = (dispatch) => (options, handler) => {
	if (!isAsyncIterableBody(options.body)) return dispatch(options, handler);
	bufferBody(options.body).then((body) => dispatch({
		...options,
		body
	}, handler), (error) => handler.onResponseError?.({
		aborted: false,
		paused: false,
		reason: null,
		abort() {},
		pause() {},
		resume() {}
	}, error instanceof Error ? error : new Error(String(error))));
	return true;
};
const sharedTransports = /* @__PURE__ */ new Map();
function dispatcherKey(baseUrl, apiKey, ca) {
	return JSON.stringify([
		new URL(baseUrl).origin,
		apiKey,
		ca?.map((cert) => cert.toString("base64"))
	]);
}
function getSharedTransport(key, ca) {
	const existing = sharedTransports.get(key);
	if (existing) return existing;
	const transport = (async () => {
		if (!undiciModule) throw new Error("The pooled control-plane transport requires Node.js");
		const { Agent, fetch } = await undiciModule;
		return {
			fetch,
			dispatcher: new Agent({
				allowH2: true,
				connections: CONTROL_PLANE_CONNECTIONS,
				keepAliveTimeout: IDLE_SESSION_TIMEOUT_MS,
				...ca === void 0 ? {} : { connect: { ca } }
			}).compose(bufferRequestBodies)
		};
	})();
	sharedTransports.set(key, transport);
	transport.catch(() => {
		if (sharedTransports.get(key) === transport) sharedTransports.delete(key);
	});
	return transport;
}
function createPooledFetch(baseUrl, apiKey, tls) {
	if (!isNodeRuntime()) {
		if (tls?.ca !== void 0) throw new Error("Custom TLS CAs require Node.js");
		return;
	}
	const ca = tls?.ca === void 0 ? void 0 : (Array.isArray(tls.ca) ? tls.ca : [tls.ca]).map((cert) => Buffer.from(cert));
	const key = dispatcherKey(baseUrl, apiKey, ca);
	return async (request) => {
		const { fetch, dispatcher } = await getSharedTransport(key, ca);
		const body = request.body === null ? null : new Uint8Array(await request.arrayBuffer());
		return await fetch(request.url, {
			method: request.method,
			headers: [...request.headers],
			body,
			redirect: request.redirect,
			signal: request.signal,
			dispatcher
		});
	};
}
function createApiClient(opts) {
	const baseUrl = opts.baseUrl ?? resolveBaseUrl(opts.region);
	const apiKey = `key-${opts.apiKey.replace(/^key-/, "")}`;
	return createClient({
		baseUrl,
		fetch: createPooledFetch(baseUrl, apiKey, opts.tls),
		headers: {
			Authorization: apiKey,
			"User-Agent": USER_AGENT
		}
	});
}
/**
* Unwrap the API envelope: return data on success, throw ArchilApiError on failure.
*/
async function unwrap(promise) {
	return (await unwrapPage(promise)).data;
}
/**
* Unwrap a paginated list envelope: like {@link unwrap}, but also surface the
* envelope's `nextCursor` (undefined on the last page or from a server that
* doesn't paginate).
*/
async function unwrapPage(promise) {
	const { data: body, error, response } = await promise;
	if (error || !body) {
		const errBody = error;
		throw new ArchilApiError(errBody?.error ?? `API request failed with status ${response.status}`, response.status, errBody?.code);
	}
	if (!body.success) throw new ArchilApiError(body.error ?? "Unknown API error", response.status, body.code);
	return {
		data: body.data,
		nextCursor: body.nextCursor
	};
}
/**
* Unwrap an API response that has no data payload (e.g., delete operations).
*/
async function unwrapEmpty(promise) {
	const { data: body, error, response } = await promise;
	if (!error && response.status === 204) return;
	if (error || !body) {
		const errBody = error;
		throw new ArchilApiError(errBody?.error ?? `API request failed with status ${response.status}`, response.status, errBody?.code);
	}
	if (!body.success) throw new ArchilApiError(body.error ?? "Unknown API error", response.status, body.code);
}
const RETRY_BASE_MS = 100;
const RETRY_CAP_MS = 2e3;
const TRANSIENT_STATUSES = /* @__PURE__ */ new Set([
	429,
	500,
	502,
	503,
	504
]);
const CONNECT_ERROR_CODES = /* @__PURE__ */ new Set([
	"CERT_HAS_EXPIRED",
	"DEPTH_ZERO_SELF_SIGNED_CERT",
	"EAI_AGAIN",
	"ECONNREFUSED",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"ENOTFOUND",
	"ETIMEDOUT",
	"ERR_TLS_CERT_ALTNAME_INVALID",
	"SELF_SIGNED_CERT_IN_CHAIN",
	"UNABLE_TO_GET_ISSUER_CERT",
	"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
	"UND_ERR_CONNECT_TIMEOUT"
]);
function isTransientStatus(status) {
	return TRANSIENT_STATUSES.has(status);
}
function retryDelayMs(attempt) {
	const ceiling = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** attempt);
	return Math.random() * ceiling;
}
function retrySleep(attempt) {
	return new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt)));
}
function isConnectionEstablishmentError(error) {
	const seen = /* @__PURE__ */ new Set();
	const pending = [error];
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current || seen.has(current)) continue;
		seen.add(current);
		if (typeof current !== "object") continue;
		const value = current;
		const code = typeof value.code === "string" ? value.code : "";
		if (CONNECT_ERROR_CODES.has(code) || code.startsWith("ERR_SSL_") || code.startsWith("ERR_TLS_")) return true;
		if (typeof value.message === "string" && value.message.includes("before secure TLS connection was established")) return true;
		if (value.cause) pending.push(value.cause);
		if (Array.isArray(value.errors)) pending.push(...value.errors);
	}
	return false;
}
async function retryApiRequest(request, mode) {
	for (let attempt = 0;; attempt++) {
		try {
			const result = await request();
			if (mode !== "transient" || !isTransientStatus(result.response.status) || attempt >= 3) return result;
		} catch (error) {
			if (!(mode === "transient" || mode === "connect" && isConnectionEstablishmentError(error)) || attempt >= 3) throw error;
		}
		await retrySleep(attempt);
	}
}
//#endregion
//#region src/disk.ts
var Disk = class {
	id;
	name;
	organization;
	status;
	provider;
	region;
	createdAt;
	fsHandlerStatus;
	lastAccessed;
	activeDataBytes;
	totalDataBytes;
	/** @deprecated Use {@link activeDataBytes}. */
	dataSize;
	monthlyUsage;
	mounts;
	metrics;
	connectedClients;
	authorizedUsers;
	allowedIps;
	/** Root-directory POSIX attributes recorded at creation, if any. */
	rootAttrs;
	/** @internal */
	_client;
	/** @internal */
	_archilRegion;
	/** Base URL for the S3-compatible API (port 9000 ingress). Empty if unset. */
	_s3BaseUrl;
	/** Lazily-constructed multipart namespace (see {@link multipart}). @internal */
	_multipart;
	/** @internal */
	constructor(data, client, archilRegion, s3BaseUrl) {
		this.id = data.id;
		this.name = data.name;
		this.organization = data.organization;
		this.status = data.status;
		this.provider = data.provider;
		this.region = data.region;
		this.createdAt = data.createdAt;
		this.fsHandlerStatus = data.fsHandlerStatus;
		this.lastAccessed = data.lastAccessed;
		this.activeDataBytes = data.activeDataBytes;
		this.totalDataBytes = data.totalDataBytes;
		this.dataSize = data.activeDataBytes;
		this.monthlyUsage = data.monthlyUsage;
		this.mounts = data.mounts;
		this.metrics = data.metrics;
		this.connectedClients = data.connectedClients;
		this.authorizedUsers = data.authorizedUsers;
		this.allowedIps = data.allowedIps;
		this.rootAttrs = data.rootAttrs;
		this._client = client;
		this._archilRegion = archilRegion;
		this._s3BaseUrl = s3BaseUrl ?? "";
	}
	toJSON() {
		return {
			id: this.id,
			name: this.name,
			organization: this.organization,
			status: this.status,
			provider: this.provider,
			region: this.region,
			createdAt: this.createdAt,
			fsHandlerStatus: this.fsHandlerStatus,
			lastAccessed: this.lastAccessed,
			activeDataBytes: this.activeDataBytes,
			totalDataBytes: this.totalDataBytes,
			monthlyUsage: this.monthlyUsage,
			mounts: this.mounts,
			metrics: this.metrics,
			connectedClients: this.connectedClients,
			authorizedUsers: this.authorizedUsers,
			allowedIps: this.allowedIps,
			rootAttrs: this.rootAttrs
		};
	}
	async addUser(user) {
		return unwrap(retryApiRequest(() => this._client.POST("/api/disks/{id}/users", {
			params: { path: { id: this.id } },
			body: user
		}), "connect"));
	}
	async removeUser(userType, identifier) {
		await unwrapEmpty(retryApiRequest(() => this._client.DELETE("/api/disks/{id}/users/{userType}", { params: {
			path: {
				id: this.id,
				userType
			},
			query: { identifier }
		} }), "connect"));
	}
	async createToken(nickname) {
		const user = await unwrap(retryApiRequest(() => this._client.POST("/api/disks/{id}/users", {
			params: { path: { id: this.id } },
			body: {
				type: "token",
				nickname
			}
		}), "connect"));
		if (!user.token || !user.identifier) throw new Error("Server did not return a generated token");
		return user;
	}
	async removeTokenUser(identifier) {
		await this.removeUser("token", identifier);
	}
	/**
	* List all delegations currently held on this disk. A delegation grants a
	* client exclusive write access to an inode; it has no ID of its own and is
	* identified by the (clientId, inodeId) pair — pass those to
	* `revokeDelegation` to release one. Entries with `isOrphaned: true` are
	* held by clients no longer connected to the disk (disconnected without
	* checking in). `path` is resolved best-effort by the server and may be
	* absent.
	*/
	async listDelegations() {
		return (await unwrap(retryApiRequest(() => this._client.GET("/api/disks/{id}/delegations", { params: { path: { id: this.id } } }), "transient"))).delegations;
	}
	/**
	* Forcibly revoke a delegation, reclaiming write access from a client that
	* is unreachable or crashed without checking its delegations in.
	*
	* Takes the `(clientId, inodeId)` pair identifying the delegation — pass an
	* entry from `listDelegations` directly:
	*
	* ```ts
	* for (const d of await disk.listDelegations()) {
	*   if (d.isOrphaned) await disk.revokeDelegation(d);
	* }
	* ```
	*/
	async revokeDelegation(delegation) {
		const { clientId, inodeId } = delegation;
		await unwrap(retryApiRequest(() => this._client.POST("/api/disks/{id}/revoke-delegation", {
			params: { path: { id: this.id } },
			body: {
				clientId,
				inodeId
			}
		}), "connect"));
	}
	/**
	* Create a branch: an independent, writable fork of this disk that starts
	* from a committed checkpoint. Writes on the branch don't affect its source.
	*
	* Fails with a 409 if a branch with this name already exists or the
	* checkpoint is not yet committed, and a 404 if the checkpoint or
	* `fromBranch` doesn't exist.
	*/
	async createBranch(options) {
		const idempotencyKey = options.idempotencyKey ?? globalThis.crypto.randomUUID();
		return unwrap(retryApiRequest(() => this._client.POST("/api/disks/{id}/branches", {
			params: {
				path: { id: this.id },
				header: { "Idempotency-Key": idempotencyKey }
			},
			body: {
				branch_name: options.name,
				from_checkpoint_name: options.fromCheckpoint,
				from_branch: options.fromBranch
			}
		}), "transient"));
	}
	/** List every branch of this disk, including branches of branches, in no particular order. */
	async listBranches() {
		return unwrap(retryApiRequest(() => this._client.GET("/api/disks/{id}/branches", { params: { path: { id: this.id } } }), "transient"));
	}
	async getBranch(name) {
		return unwrap(retryApiRequest(() => this._client.GET("/api/disks/{id}/branches/{name}", { params: { path: {
			id: this.id,
			name
		} } }), "transient"));
	}
	async getAllowedIPs() {
		return (await unwrap(retryApiRequest(() => this._client.GET("/api/disks/{id}/allowed-ips", { params: { path: { id: this.id } } }), "transient"))).allowedIps;
	}
	async setAllowedIPs(allowedIps) {
		return (await unwrap(retryApiRequest(() => this._client.PUT("/api/disks/{id}/allowed-ips", {
			params: { path: { id: this.id } },
			body: { allowedIps }
		}), "transient"))).allowedIps;
	}
	async addAllowedIP(ip) {
		const current = await this.getAllowedIPs();
		if (current.includes(ip)) return current;
		return this.setAllowedIPs([...current, ip]);
	}
	async removeAllowedIP(ip) {
		const current = await this.getAllowedIPs();
		return this.setAllowedIPs(current.filter((i) => i !== ip));
	}
	async delete() {
		await unwrapEmpty(retryApiRequest(() => this._client.DELETE("/api/disks/{id}", { params: { path: { id: this.id } } }), "connect"));
	}
	/**
	* Execute a command in a container with this disk mounted.
	* Blocks until the command completes and returns stdout, stderr, and exit code.
	*/
	async exec(command) {
		return unwrap(retryApiRequest(() => this._client.POST("/api/disks/{id}/exec", {
			params: { path: { id: this.id } },
			body: { command }
		}), "connect"));
	}
	/**
	* Constant-time parallel grep across files on this disk. Listing and
	* matching are fanned out across ephemeral exec containers; the request
	* finishes within the supplied time budget regardless of dataset size.
	*
	* The returned `stoppedReason` says whether the search ran to completion
	* or short-circuited on `maxResults` / `maxDurationSeconds`. When
	* stopping early, the matches returned are a sample (whichever workers
	* reported first), not the lexicographically first N.
	*/
	async grep(opts) {
		return unwrap(retryApiRequest(() => this._client.POST("/api/disks/{id}/grep", {
			params: { path: { id: this.id } },
			body: {
				directory: opts.directory,
				pattern: opts.pattern,
				recursive: opts.recursive ?? false,
				maxDurationSeconds: opts.maxDurationSeconds ?? 30,
				concurrency: opts.concurrency ?? 50,
				maxResults: opts.maxResults ?? 1e3
			}
		}), "transient"));
	}
	/**
	* Create a signed, time-limited URL that lets anyone download a single file
	* from this disk without authentication. The returned URL embeds a
	* cryptographically signed token carrying the disk, the file's key, and an
	* expiry — share it directly; no API key is needed to redeem it.
	*
	* @param key   Path to the file on the disk (e.g. "reports/2026-01/data.pdf").
	* @param opts  `expiresIn` sets the URL lifetime in seconds (any positive
	*              integer, max 604800 = 7 days). Defaults to 24h.
	*/
	async share(key, opts = {}) {
		const body = { key };
		if (opts.expiresIn !== void 0) body.expiresIn = opts.expiresIn;
		const call = this._client.POST;
		return unwrap(retryApiRequest(() => call(`/api/disks/${this.id}/share`, { body }), "connect"));
	}
	/**
	* Read an object from the disk via the S3-compatible GetObject API and return
	* its full contents as bytes. Throws `ArchilS3Error` if the object does not
	* exist (status 404, code "NoSuchKey") or the request is rejected; use
	* `headObject`/`objectExists` to check existence without throwing.
	*
	* @param key  Path on the disk (e.g. "reports/2026-01/data.json")
	*/
	async getObject(key) {
		const resp = await this._s3Request("GET", key);
		if (!resp.ok) throw parseS3Error("GetObject", resp.status, resp.statusText, decodeText(resp.body));
		return resp.body;
	}
	/**
	* Fetch an object's metadata (size, etag, content type, last-modified) without
	* downloading its contents, via the S3-compatible HeadObject API. Returns
	* `null` if the object does not exist.
	*
	* @param key  Path on the disk (e.g. "reports/2026-01/data.json")
	*/
	async headObject(key) {
		const resp = await this._s3Request("HEAD", key);
		if (resp.status === 404) return null;
		if (!resp.ok) throw parseS3Error("HeadObject", resp.status, resp.statusText, decodeText(resp.body));
		const lastModified = resp.headers.get("last-modified");
		return {
			size: Number(resp.headers.get("content-length") ?? 0),
			etag: resp.headers.get("etag") ?? void 0,
			contentType: resp.headers.get("content-type") ?? void 0,
			lastModified: lastModified ? new Date(lastModified) : void 0
		};
	}
	/** Whether an object exists on the disk (a HeadObject that maps 404 → false). */
	async objectExists(key) {
		return await this.headObject(key) !== null;
	}
	/**
	* Write an object to the disk via the S3-compatible API. Handles any size:
	* bodies at or below `multipartThreshold` (defaults to `partSize`, i.e.
	* 16 MiB) go through a single PutObject request; larger bodies are uploaded as
	* a multipart upload — split into `partSize` parts, uploaded with bounded
	* `concurrency` (default 4), and assembled. A failed part aborts the upload so
	* nothing is left half-staged. For manual control over the multipart
	* lifecycle, use the {@link multipart} namespace.
	*
	* Faster than exec for large files — no container overhead, no command-length
	* limits. Returns the entity tag the server assigned (a multipart upload's tag
	* is S3's `md5(concat(partMd5s))-N` form rather than a plain MD5).
	*
	* Optional `mode` / `uid` / `gid` set the POSIX attributes of the published
	* file (e.g. `{ mode: 0o644, uid: 1000, gid: 1000 }` for a non-root agent
	* sandbox). Missing parent directories inherit `uid` / `gid` with mode
	* `0755`; existing directories remain unchanged. A key ending in `/` creates
	* an explicit directory marker whose leaf uses the requested attributes.
	* Defaults are `root:root 0644` for files and `root:root 0755` for directories.
	*
	* @param key      Path on the disk (e.g. "reports/2026-01/data.json")
	* @param body     Contents as a string, Uint8Array/Buffer, or ArrayBuffer
	* @param options  Either a content-type string, or {@link PutObjectOptions}
	*                 (`contentType`, `multipartThreshold`, `partSize`,
	*                 `concurrency`, `mode`, `uid`, `gid`). Content type defaults
	*                 to "application/octet-stream".
	*/
	async putObject(key, body, options) {
		const opts = typeof options === "string" ? { contentType: options } : options ?? {};
		const contentType = opts.contentType ?? "application/octet-stream";
		const partSize = Math.max(opts.partSize ?? DEFAULT_PART_SIZE, MIN_PART_SIZE);
		const threshold = opts.multipartThreshold ?? partSize;
		const bytes = toBytes(body);
		if (bytes.length <= threshold) {
			const resp = await this._s3Request("PUT", key, {
				body,
				contentType,
				extraHeaders: posixCreateHeaders(opts)
			});
			if (!resp.ok) throw parseS3Error("PutObject", resp.status, resp.statusText, decodeText(resp.body));
			return { etag: resp.headers.get("etag") ?? void 0 };
		}
		return this._putMultipart(key, bytes, contentType, partSize, Math.max(1, opts.concurrency ?? DEFAULT_UPLOAD_CONCURRENCY), opts);
	}
	/**
	* Upload a large body through the multipart lifecycle: split into `partSize`
	* parts, upload them with bounded concurrency, then complete — aborting the
	* upload if any part fails so nothing is left half-staged. @internal
	*/
	async _putMultipart(key, bytes, contentType, partSize, concurrency, attrs = {}) {
		const effectivePartSize = effectiveUploadPartSize(bytes.length, partSize);
		const mp = this.multipart;
		const upload = await mp.create(key, contentType, attrs);
		try {
			const partCount = Math.ceil(bytes.length / effectivePartSize);
			const parts = new Array(partCount);
			let next = 0;
			const worker = async () => {
				for (;;) {
					const index = next++;
					if (index >= partCount) return;
					const start = index * effectivePartSize;
					const slice = bytes.subarray(start, Math.min(start + effectivePartSize, bytes.length));
					parts[index] = await mp.uploadPart(key, upload.uploadId, index + 1, slice);
				}
			};
			await Promise.all(Array.from({ length: Math.min(concurrency, partCount) }, worker));
			return { etag: (await mp.complete(key, upload.uploadId, parts)).etag };
		} catch (err) {
			await mp.abort(key, upload.uploadId).catch(() => {});
			throw err;
		}
	}
	/**
	* Append bytes to an object via the S3-compatible PutObject append extension
	* (`?append=true`). If the object already exists the bytes are appended to it;
	* if it doesn't, it is created. Returns the entity tag of the full object
	* after the append.
	*
	* Each call may append at most 1 MiB — the server rejects a larger body with
	* `EntityTooLarge`. To grow an object past that, append in chunks (or use
	* {@link putObject} for a one-shot large write).
	*
	* Unlike most operations this is NOT auto-retried on a transient error:
	* append isn't idempotent, so retrying a succeeded-but-unacknowledged append
	* would duplicate the bytes. On a transient failure, re-append yourself only
	* after confirming the object's size.
	*
	* When the object does not yet exist, optional `mode` / `uid` / `gid` set the
	* POSIX attributes of the newly created file (same headers as
	* {@link putObject}); missing parents inherit `uid` / `gid` with mode `0755`.
	* Existing files and directories are unchanged.
	*
	* @param key      Path on the disk (e.g. "logs/app.log")
	* @param body     Bytes to append (string, Uint8Array/Buffer, or ArrayBuffer)
	* @param options  Either a content-type string, or {@link AppendObjectOptions}
	*                 (`contentType`, `mode`, `uid`, `gid`). Content type defaults
	*                 to "application/octet-stream" and applies only when the
	*                 object is newly created.
	*/
	async appendObject(key, body, options) {
		const opts = typeof options === "string" ? { contentType: options } : options ?? {};
		const resp = await this._s3Request("PUT", key, {
			body,
			contentType: opts.contentType ?? "application/octet-stream",
			query: { append: "true" },
			retry: false,
			extraHeaders: posixCreateHeaders(opts)
		});
		if (!resp.ok) throw parseS3Error("AppendObject", resp.status, resp.statusText, decodeText(resp.body));
		return { etag: resp.headers.get("etag") ?? void 0 };
	}
	/**
	* Delete an object from the disk via the S3-compatible DeleteObject API.
	* Idempotent: deleting a key that doesn't exist resolves successfully, per
	* S3 semantics.
	*
	* @param key  Path on the disk (e.g. "project/dist/server.cjs")
	*/
	async deleteObject(key) {
		const resp = await this._s3Request("DELETE", key);
		if (!resp.ok && resp.status !== 404) throw parseS3Error("DeleteObject", resp.status, resp.statusText, decodeText(resp.body));
	}
	/**
	* List objects on the disk via the S3-compatible ListObjectsV2 API. By
	* default this follows continuation tokens until the listing is exhausted and
	* returns every matching key. Use `limit` to cap the total, `singlePage` for a
	* single request, or {@link listObjectsPages} to stream pages without loading
	* everything into memory.
	*
	* @param prefix  Only return keys beginning with this prefix (omit for all).
	* @param opts    Listing and pagination options.
	*/
	async listObjects(prefix, opts = {}) {
		if (opts.singlePage) return this._listObjectsPage(prefix, opts);
		const objects = [];
		const commonPrefixes = [];
		const seenPrefixes = /* @__PURE__ */ new Set();
		let echoedPrefix;
		let truncated = false;
		outer: for await (const page of this.listObjectsPages(prefix, opts)) {
			echoedPrefix = page.prefix;
			for (const cp of page.commonPrefixes) if (!seenPrefixes.has(cp)) {
				seenPrefixes.add(cp);
				commonPrefixes.push(cp);
			}
			for (const obj of page.objects) {
				if (opts.limit !== void 0 && objects.length >= opts.limit) {
					truncated = true;
					break outer;
				}
				objects.push(obj);
			}
		}
		return {
			objects,
			commonPrefixes,
			isTruncated: truncated,
			keyCount: objects.length,
			prefix: echoedPrefix
		};
	}
	/**
	* Yield ListObjectsV2 pages lazily, following continuation tokens. A
	* memory-friendly way to process a large listing without materializing it:
	*
	* ```ts
	* for await (const page of disk.listObjectsPages("logs/")) {
	*   for (const obj of page.objects) process(obj);
	* }
	* ```
	*
	* @param prefix  Only return keys beginning with this prefix (omit for all).
	* @param opts    Listing options (`limit` / `singlePage` are ignored here —
	*                control your own loop).
	*/
	async *listObjectsPages(prefix, opts = {}) {
		const seenTokens = /* @__PURE__ */ new Set();
		let continuationToken = opts.continuationToken;
		for (;;) {
			const page = await this._listObjectsPage(prefix, {
				...opts,
				continuationToken
			});
			yield page;
			const next = page.isTruncated ? page.nextContinuationToken : void 0;
			if (!next || seenTokens.has(next)) break;
			seenTokens.add(next);
			continuationToken = next;
		}
	}
	/** Fetch a single ListObjectsV2 page. @internal */
	async _listObjectsPage(prefix, opts) {
		const query = { "list-type": 2 };
		if (prefix !== void 0) query.prefix = prefix;
		if (!opts.recursive) query.delimiter = "/";
		if (opts.continuationToken !== void 0) query["continuation-token"] = opts.continuationToken;
		if (opts.startAfter !== void 0) query["start-after"] = opts.startAfter;
		const resp = await this._s3Request("GET", "", { query });
		if (!resp.ok) throw parseS3Error("ListObjectsV2", resp.status, resp.statusText, decodeText(resp.body));
		return parseListObjectsResult(decodeText(resp.body));
	}
	/**
	* Delete up to many objects in a single S3-compatible DeleteObjects request.
	* Unlike {@link deleteObject}, failures are reported per key rather than
	* thrown: the result's `deleted` lists the keys that were removed and
	* `errors` lists the ones that weren't (with the server's code/message). A
	* key that didn't exist still counts as deleted, per S3 semantics.
	*
	* The server caps a single request at 1000 keys; this method transparently
	* splits larger inputs into 1000-key batches and merges the results.
	*
	* @param keys  Object keys to delete.
	* @param opts  `quiet` suppresses the per-key success list server-side.
	*/
	async deleteObjects(keys, opts = {}) {
		const deleted = [];
		const errors = [];
		for (let i = 0; i < keys.length; i += MAX_DELETE_OBJECTS_PER_REQUEST) {
			const xml = buildDeleteObjectsXml(keys.slice(i, i + MAX_DELETE_OBJECTS_PER_REQUEST), opts.quiet ?? false);
			const resp = await this._s3Request("POST", "", {
				query: { delete: "" },
				body: xml,
				contentType: "application/xml"
			});
			if (!resp.ok) throw parseS3Error("DeleteObjects", resp.status, resp.statusText, decodeText(resp.body));
			const parsed = parseDeleteObjectsResult(decodeText(resp.body));
			deleted.push(...parsed.deleted);
			errors.push(...parsed.errors);
		}
		return {
			deleted,
			errors
		};
	}
	/**
	* The advanced, opt-in multipart-upload API. Drive the raw lifecycle
	* yourself — `create` → `uploadPart` → `complete` (or `abort`), plus
	* `listParts` / `listUploads`. Most callers don't need this: {@link putObject}
	* runs the whole lifecycle automatically for large bodies. Reach for it only
	* when you need manual control (e.g. uploading parts from separate processes),
	* and note you then own part-size, memory, and concurrency management.
	*/
	get multipart() {
		return this._multipart ??= new DiskMultipart(this.id, this._s3Request.bind(this));
	}
	/**
	* Send a single request to the disk's S3-compatible endpoint. This reuses the
	* control-plane client purely for its credential and transport — the same
	* `Authorization` header is sent and verified by the same code server-side —
	* pointed at the S3 host. Returns the response status and fully-buffered body
	* so callers can inspect both regardless of the verb used.
	*
	* The S3 routes (`/{diskId}/{key}` for objects, `/{diskId}` for the bucket)
	* are not part of the typed control-plane API, so the path and per-request
	* options are passed untyped. An empty `key` targets the bucket itself (used
	* by listObjects).
	*
	* @internal
	*/
	async _s3Request(method, key, opts = {}) {
		if (!this._s3BaseUrl) throw new Error("S3 base URL not configured. Pass s3BaseUrl to new Archil({...}) or set ARCHIL_S3_BASE_URL.");
		const call = this._client[method];
		const encodedKey = key.replace(/^\//, "").split("/").map(encodeURIComponent).join("/");
		const path = encodedKey ? `/${this.id}/${encodedKey}` : `/${this.id}`;
		const init = {
			baseUrl: this._s3BaseUrl,
			parseAs: "stream",
			...opts.query ? { params: { query: opts.query } } : {},
			...opts.body !== void 0 ? {
				body: opts.body,
				bodySerializer: (b) => b
			} : {},
			...opts.contentType || opts.extraHeaders ? { headers: {
				...opts.contentType ? { "Content-Type": opts.contentType } : {},
				...opts.extraHeaders
			} } : {}
		};
		const hasBody = method === "GET" || method === "POST";
		const maxRetries = opts.retry === false ? 0 : 3;
		for (let attempt = 0;; attempt++) {
			let error;
			let response;
			try {
				({error, response} = await call(path, init));
			} catch (transportError) {
				if (attempt < maxRetries) {
					await retrySleep(attempt);
					continue;
				}
				throw transportError;
			}
			if (!response.ok) {
				if (isTransientStatus(response.status) && attempt < maxRetries) {
					await response.body?.cancel().catch(() => {});
					await retrySleep(attempt);
					continue;
				}
				const message = typeof error === "string" ? error : error ? JSON.stringify(error) : "";
				return {
					ok: false,
					status: response.status,
					statusText: response.statusText,
					headers: response.headers,
					body: new TextEncoder().encode(message)
				};
			}
			const bytes = hasBody ? new Uint8Array(await response.arrayBuffer()) : /* @__PURE__ */ new Uint8Array(0);
			return {
				ok: true,
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
				body: bytes
			};
		}
	}
	/**
	* Connect to this disk's data plane via the native ArchilClient.
	*
	* Requires the native module to be available (platform-specific .node binary).
	*/
	async mount(opts) {
		let ArchilClient;
		try {
			const native = await import("@archildata/native");
			ArchilClient = native.ArchilClient ?? native.default?.ArchilClient;
			if (!ArchilClient) throw new Error("@archildata/native did not export ArchilClient");
		} catch {
			throw new Error("Native client not available. Install @archildata/native (platform-specific binary) or use ArchilClient.connect() directly. mount() is not supported in browsers.");
		}
		return ArchilClient.connect({
			region: this._archilRegion,
			diskName: `${this.organization}/${this.name}`,
			authToken: opts?.authToken,
			logLevel: opts?.logLevel,
			serverAddress: opts?.serverAddress,
			insecure: opts?.insecure
		});
	}
};
/**
* The advanced, opt-in multipart-upload namespace, reached via {@link Disk.multipart}.
* Drives the raw S3 multipart lifecycle — `create` → `uploadPart` → `complete`
* (or `abort`), plus `listParts` / `listUploads`. Prefer {@link Disk.putObject},
* which runs this lifecycle automatically for large bodies; use this only when
* you need manual control, in which case you own part-size, memory, and
* concurrency management.
*/
var DiskMultipart = class {
	diskId;
	s3Request;
	/** @internal */
	constructor(diskId, s3Request) {
		this.diskId = diskId;
		this.s3Request = s3Request;
	}
	/**
	* Start a multipart upload (CreateMultipartUpload) and return its `uploadId`.
	*
	* @param key          Path on the disk the finished object will live at.
	* @param contentType  MIME type to store the object with.
	* @param attrs        Optional POSIX `mode` / `uid` / `gid` for the completed
	*                     object (see {@link PosixCreateAttrs}).
	*/
	async create(key, contentType, attrs = {}) {
		const resp = await this.s3Request("POST", key, {
			query: { uploads: "" },
			contentType,
			extraHeaders: posixCreateHeaders(attrs)
		});
		if (!resp.ok) throw parseS3Error("CreateMultipartUpload", resp.status, resp.statusText, decodeText(resp.body));
		const root = parseXml(decodeText(resp.body)).InitiateMultipartUploadResult ?? {};
		const uploadId = optionalString(root.UploadId);
		if (!uploadId) throw new ArchilS3Error({
			operation: "CreateMultipartUpload",
			statusCode: resp.status,
			message: "response did not contain an UploadId",
			raw: decodeText(resp.body)
		});
		return {
			uploadId,
			key: optionalString(root.Key) ?? key,
			bucket: optionalString(root.Bucket) ?? this.diskId
		};
	}
	/**
	* Upload one part (UploadPart) and return its entity tag, which you must
	* collect (with its part number) and pass to {@link complete}. Every part
	* except the last must be at least 5 MiB.
	*
	* @param key         The upload's object key.
	* @param uploadId    The id from {@link create}.
	* @param partNumber  1-based part number (1..=10000).
	* @param body        Part contents as a string, Uint8Array/Buffer, or ArrayBuffer.
	*/
	async uploadPart(key, uploadId, partNumber, body) {
		const resp = await this.s3Request("PUT", key, {
			query: {
				uploadId,
				partNumber
			},
			body
		});
		if (!resp.ok) throw parseS3Error("UploadPart", resp.status, resp.statusText, decodeText(resp.body));
		return {
			partNumber,
			etag: resp.headers.get("etag") ?? ""
		};
	}
	/**
	* Finish a multipart upload (CompleteMultipartUpload), assembling the listed
	* parts into one object. Parts are sorted by part number before submission
	* (the server requires strictly-increasing order).
	*
	* Unlike the other operations this is NOT auto-retried on a transient error:
	* the gateway isn't idempotent for completion, so a retry after a
	* successful-but-unacknowledged complete would return a spurious NoSuchUpload.
	* On a transient failure, re-drive completion yourself only after confirming
	* the object isn't already present.
	*
	* @param key       The upload's object key.
	* @param uploadId  The id from {@link create}.
	* @param parts     The `{ partNumber, etag }` pairs from {@link uploadPart}.
	*/
	async complete(key, uploadId, parts) {
		const xml = buildCompleteMultipartUploadXml([...parts].sort((a, b) => a.partNumber - b.partNumber));
		const resp = await this.s3Request("POST", key, {
			query: { uploadId },
			body: xml,
			contentType: "application/xml",
			retry: false
		});
		if (!resp.ok) throw parseS3Error("CompleteMultipartUpload", resp.status, resp.statusText, decodeText(resp.body));
		const root = parseXml(decodeText(resp.body)).CompleteMultipartUploadResult ?? {};
		return {
			etag: optionalString(root.ETag),
			location: optionalString(root.Location),
			bucket: optionalString(root.Bucket),
			key: optionalString(root.Key)
		};
	}
	/**
	* Abort a multipart upload (AbortMultipartUpload), discarding every staged
	* part. Idempotent against an upload that's already gone (404 / NoSuchUpload
	* resolves successfully).
	*
	* @param key       The upload's object key.
	* @param uploadId  The id from {@link create}.
	*/
	async abort(key, uploadId) {
		const resp = await this.s3Request("DELETE", key, { query: { uploadId } });
		if (!resp.ok && resp.status !== 404) throw parseS3Error("AbortMultipartUpload", resp.status, resp.statusText, decodeText(resp.body));
	}
	/**
	* List the parts already uploaded for an in-progress upload (ListParts).
	* Returns a single page; follow `nextPartNumberMarker` (when `isTruncated`)
	* to page through the rest.
	*
	* @param key       The upload's object key.
	* @param uploadId  The id from {@link create}.
	* @param opts      `maxParts` / `partNumberMarker` pagination controls.
	*/
	async listParts(key, uploadId, opts = {}) {
		const query = { uploadId };
		if (opts.maxParts !== void 0) query["max-parts"] = opts.maxParts;
		if (opts.partNumberMarker !== void 0) query["part-number-marker"] = opts.partNumberMarker;
		const resp = await this.s3Request("GET", key, { query });
		if (!resp.ok) throw parseS3Error("ListParts", resp.status, resp.statusText, decodeText(resp.body));
		return parseListPartsResult(decodeText(resp.body));
	}
	/**
	* List in-progress multipart uploads on the disk (ListMultipartUploads).
	* Returns a single page; follow `nextKeyMarker` / `nextUploadIdMarker` (when
	* `isTruncated`) for the rest.
	*
	* @param opts  Prefix/delimiter filter and pagination markers.
	*/
	async listUploads(opts = {}) {
		const query = { uploads: "" };
		if (opts.prefix !== void 0) query.prefix = opts.prefix;
		if (opts.delimiter !== void 0) query.delimiter = opts.delimiter;
		if (opts.keyMarker !== void 0) query["key-marker"] = opts.keyMarker;
		if (opts.uploadIdMarker !== void 0) query["upload-id-marker"] = opts.uploadIdMarker;
		if (opts.maxUploads !== void 0) query["max-uploads"] = opts.maxUploads;
		const resp = await this.s3Request("GET", "", { query });
		if (!resp.ok) throw parseS3Error("ListMultipartUploads", resp.status, resp.statusText, decodeText(resp.body));
		return parseListMultipartUploadsResult(decodeText(resp.body));
	}
};
/**
* Headers the S3 gateway accepts to set POSIX mode/owner on newly created
* objects (see fshandler `x-archil-*` PutObject attrs).
*/
const ARCHIL_MODE_HEADER = "x-archil-mode";
const ARCHIL_UID_HEADER = "x-archil-uid";
const ARCHIL_GID_HEADER = "x-archil-gid";
/**
* Build the `x-archil-*` headers for {@link PosixCreateAttrs}. `mode` is sent
* in octal (`0o640` → "640"), matching the gateway's parser and the Python SDK.
* Returns undefined when no attribute is set, so no headers are added.
*/
function posixCreateHeaders(attrs) {
	const headers = {};
	if (attrs.mode !== void 0) headers[ARCHIL_MODE_HEADER] = attrs.mode.toString(8);
	if (attrs.uid !== void 0) headers[ARCHIL_UID_HEADER] = String(attrs.uid);
	if (attrs.gid !== void 0) headers[ARCHIL_GID_HEADER] = String(attrs.gid);
	return Object.keys(headers).length > 0 ? headers : void 0;
}
/** S3's per-request cap on DeleteObjects keys; larger inputs are batched. */
const MAX_DELETE_OBJECTS_PER_REQUEST = 1e3;
/** S3's minimum size for every multipart part but the last (5 MiB). */
const MIN_PART_SIZE = 5 * 1024 * 1024;
/** Default part size {@link Disk.putObject} uses on the multipart path (16 MiB). */
const DEFAULT_PART_SIZE = 16 * 1024 * 1024;
/** Default number of parts {@link Disk.putObject} uploads in parallel. */
const DEFAULT_UPLOAD_CONCURRENCY = 4;
/** The server's cap on parts in a single multipart upload (MAX_PARTS_PER_UPLOAD). */
const MAX_PARTS_PER_UPLOAD = 1e4;
/**
* Choose the part size for a `totalBytes` multipart upload. Returns
* `requestedPartSize` unless splitting at that size would exceed the server's
* 10,000-part cap, in which case it grows the part size (rounded up to a whole
* MiB) so the body fits in ≤ 10,000 parts — mirroring boto3's chunk-size
* adjustment. Parts only ever get larger, so they stay above the 5 MiB floor.
*/
function effectiveUploadPartSize(totalBytes, requestedPartSize) {
	if (Math.ceil(totalBytes / requestedPartSize) <= MAX_PARTS_PER_UPLOAD) return requestedPartSize;
	const MiB = 1024 * 1024;
	const needed = Math.ceil(totalBytes / MAX_PARTS_PER_UPLOAD);
	return Math.ceil(needed / MiB) * MiB;
}
/** Normalize an upload body to bytes so it can be sized and sliced into parts. */
function toBytes(body) {
	if (typeof body === "string") return new TextEncoder().encode(body);
	if (body instanceof Uint8Array) return body;
	return new Uint8Array(body);
}
/** Escape text for safe inclusion in XML element content. */
function escapeXml(value) {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
/** Build a `<Delete>` request body for the DeleteObjects API. */
function buildDeleteObjectsXml(keys, quiet) {
	return `<?xml version="1.0" encoding="UTF-8"?><Delete>${keys.map((k) => `<Object><Key>${escapeXml(k)}</Key></Object>`).join("")}${quiet ? "<Quiet>true</Quiet>" : ""}</Delete>`;
}
/** Build a `<CompleteMultipartUpload>` request body from the uploaded parts. */
function buildCompleteMultipartUploadXml(parts) {
	return `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUpload>${parts.map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${escapeXml(p.etag)}</ETag></Part>`).join("")}</CompleteMultipartUpload>`;
}
/** Coerce a parser value that may be a single object or an array into an array. */
function asArray(value) {
	if (value === void 0 || value === null) return [];
	return Array.isArray(value) ? value : [value];
}
function optionalNumber(value) {
	return value === void 0 || value === null ? void 0 : Number(value);
}
function optionalString(value) {
	return value === void 0 || value === null ? void 0 : String(value);
}
function optionalDate(value) {
	return value === void 0 || value === null ? void 0 : new Date(String(value));
}
/** Decode response bytes to a UTF-8 string (used for XML error/result bodies). */
function decodeText(bytes) {
	return new TextDecoder().decode(bytes);
}
/** Parse an S3 ListObjectsV2 `<ListBucketResult>` XML document. */
function parseListObjectsResult(xml) {
	const root = parseXml(xml).ListBucketResult ?? {};
	const objects = (root.Contents ?? []).map((c) => ({
		key: String(c.Key ?? ""),
		size: Number(c.Size ?? 0),
		etag: optionalString(c.ETag),
		lastModified: optionalDate(c.LastModified)
	}));
	return {
		objects,
		commonPrefixes: (root.CommonPrefixes ?? []).map((cp) => optionalString(cp.Prefix)).filter((p) => p !== void 0),
		isTruncated: root.IsTruncated === "true" || root.IsTruncated === true,
		nextContinuationToken: optionalString(root.NextContinuationToken),
		keyCount: root.KeyCount !== void 0 ? Number(root.KeyCount) : objects.length,
		prefix: optionalString(root.Prefix)
	};
}
function xmlIsTruncated(value) {
	return value === "true" || value === true;
}
/** Parse an S3 DeleteObjects `<DeleteResult>` XML document. */
function parseDeleteObjectsResult(xml) {
	const root = parseXml(xml).DeleteResult ?? {};
	return {
		deleted: asArray(root.Deleted).map((d) => optionalString(d.Key)).filter((k) => k !== void 0),
		errors: asArray(root.Error).map((e) => ({
			key: String(e.Key ?? ""),
			code: optionalString(e.Code),
			message: optionalString(e.Message)
		}))
	};
}
/** Parse an S3 `<ListPartsResult>` XML document. */
function parseListPartsResult(xml) {
	const root = parseXml(xml).ListPartsResult ?? {};
	const parts = asArray(root.Part).map((p) => ({
		partNumber: Number(p.PartNumber ?? 0),
		etag: optionalString(p.ETag),
		size: Number(p.Size ?? 0),
		lastModified: optionalDate(p.LastModified)
	}));
	return {
		bucket: optionalString(root.Bucket),
		key: optionalString(root.Key),
		uploadId: optionalString(root.UploadId),
		parts,
		isTruncated: xmlIsTruncated(root.IsTruncated),
		partNumberMarker: Number(root.PartNumberMarker ?? 0),
		nextPartNumberMarker: optionalNumber(root.NextPartNumberMarker),
		maxParts: Number(root.MaxParts ?? parts.length)
	};
}
/** Parse an S3 `<ListMultipartUploadsResult>` XML document. */
function parseListMultipartUploadsResult(xml) {
	const root = parseXml(xml).ListMultipartUploadsResult ?? {};
	const uploads = asArray(root.Upload).map((u) => ({
		key: String(u.Key ?? ""),
		uploadId: String(u.UploadId ?? ""),
		initiated: optionalDate(u.Initiated)
	}));
	const commonPrefixes = asArray(root.CommonPrefixes).map((cp) => optionalString(cp.Prefix)).filter((p) => p !== void 0);
	return {
		bucket: optionalString(root.Bucket),
		uploads,
		commonPrefixes,
		isTruncated: xmlIsTruncated(root.IsTruncated),
		keyMarker: optionalString(root.KeyMarker),
		uploadIdMarker: optionalString(root.UploadIdMarker),
		nextKeyMarker: optionalString(root.NextKeyMarker),
		nextUploadIdMarker: optionalString(root.NextUploadIdMarker),
		prefix: optionalString(root.Prefix),
		delimiter: optionalString(root.Delimiter),
		maxUploads: optionalNumber(root.MaxUploads)
	};
}
//#endregion
//#region src/disks.ts
/** Server-side maximum page size for GET /api/disks. */
const DISK_PAGE_LIMIT = 100;
var Disks = class {
	/** @internal */
	_client;
	/** @internal */
	_region;
	/** @internal */
	_s3BaseUrl;
	/** @internal */
	constructor(client, region, s3BaseUrl) {
		this._client = client;
		this._region = region;
		this._s3BaseUrl = s3BaseUrl;
	}
	/**
	* List the account's disks. Fetches in cursor-driven pages (bounded server
	* work per request) and follows `nextCursor` until exhausted, so the result
	* is complete even for very large accounts. Use `limit` to cap the total, or
	* {@link listPage} to walk pages yourself.
	*/
	async list(opts) {
		if (opts?.name !== void 0) return (await this.listPage(opts)).disks;
		const limit = opts?.limit;
		let cursor = opts?.cursor;
		const disks = [];
		for (;;) {
			const remaining = limit === void 0 ? void 0 : limit - disks.length;
			if (remaining !== void 0 && remaining <= 0) return disks;
			const pageLimit = remaining === void 0 ? DISK_PAGE_LIMIT : Math.min(remaining, DISK_PAGE_LIMIT);
			const page = await this.listPage({
				limit: pageLimit,
				cursor
			});
			disks.push(...remaining === void 0 ? page.disks : page.disks.slice(0, remaining));
			if (!page.nextCursor || page.nextCursor === cursor) return disks;
			cursor = page.nextCursor;
		}
	}
	/**
	* Fetch a single page of disks. `nextCursor` on the result resumes the
	* listing (it can also be persisted, e.g. across requests of a paginated UI).
	*/
	async listPage(opts) {
		const { data, nextCursor } = await unwrapPage(retryApiRequest(() => this._client.GET("/api/disks", { params: { query: {
			limit: opts?.limit,
			cursor: opts?.cursor,
			name: opts?.name
		} } }), "transient"));
		const disks = (data ?? []).map((d) => new Disk(d, this._client, this._region, this._s3BaseUrl));
		return nextCursor ? {
			disks,
			nextCursor
		} : { disks };
	}
	async get(id) {
		return new Disk(await unwrap(retryApiRequest(() => this._client.GET("/api/disks/{id}", { params: { path: { id } } }), "transient")), this._client, this._region, this._s3BaseUrl);
	}
	/**
	* Create a new disk with an auto-generated mount token.
	*
	* Returns the Disk, the one-time token (save it — it cannot be retrieved
	* again), and the token identifier for later management.
	*
	* `rootAttrs` sets the POSIX owner and mode of the disk's root directory
	* (e.g. `{ uid: 1000, gid: 1000, mode: 0o755 }` so an unprivileged process
	* can create entries under the mount root without a post-mount `chown`).
	* Creation-time only.
	*/
	async create(req) {
		const resp = await unwrap(retryApiRequest(() => this._client.POST("/api/disks", { body: req }), "connect"));
		if (!resp.diskId) throw new Error("API returned success but no diskId");
		const authorizedUsers = resp.authorizedUsers ?? [];
		const tokenUser = authorizedUsers.find((u) => u.token);
		return {
			disk: await this.get(resp.diskId),
			token: tokenUser?.token ?? null,
			tokenIdentifier: tokenUser?.identifier ?? null,
			authorizedUsers
		};
	}
	/**
	* Execute a command on a disk that is already known to exist. Accepts the
	* disk ID directly so callers that do not need its metadata can execute
	* without fetching the disk first.
	*/
	async exec(id, command) {
		return unwrap(retryApiRequest(() => this._client.POST("/api/disks/{id}/exec", {
			params: { path: { id } },
			body: { command }
		}), "connect"));
	}
};
//#endregion
//#region src/images.ts
const DEFAULT_BUILD_TIMEOUT_SECONDS = 1800;
const MAX_INTERRUPTED_RETRIES = 3;
const REQUEST_AGAIN_MS = 2 * 6e4;
const FIRST_POLL_MS = 1e3;
const MAX_POLL_MS = 5e3;
function imageFromWire(data) {
	return {
		imageId: data.image_id,
		source: data.source,
		private: data.private,
		status: data.status,
		digest: data.digest,
		canonicalSource: data.canonical_source,
		failureReason: data.failure_reason,
		createdAt: new Date(data.created_at),
		updatedAt: new Date(data.updated_at)
	};
}
var Images = class {
	/** @internal */
	_client;
	/** @internal */
	constructor(client) {
		this._client = client;
	}
	async get(imageId) {
		return imageFromWire(await unwrap(retryApiRequest(() => this._client.GET("/api/images/{image_id}", { params: { path: { image_id: imageId } } }), "transient")));
	}
	/**
	* Build a sandbox image from an OCI reference and wait until it is ready.
	* Returns at once when the image is already built from a digest reference
	* and joins a build that is already running. A tag is rebuilt on each call
	* in case it moved, so call this once and reuse `imageId`. Interrupted
	* builds are requested again up to three times; other failures throw
	* {@link ImageBuildError}.
	*/
	async build(request, options = {}) {
		const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_BUILD_TIMEOUT_SECONDS;
		const deadline = Date.now() + timeoutSeconds * 1e3;
		let image = await this._request(request);
		let lastRequest = Date.now();
		let retries = 0;
		let pollMs = FIRST_POLL_MS;
		for (;;) {
			if (image.status === "ready") return image;
			if (image.status === "failed") {
				if (image.failureReason !== "interrupted" || retries >= MAX_INTERRUPTED_RETRIES) throw new ImageBuildError(image);
				retries++;
				image = await this._request(request);
				lastRequest = Date.now();
				continue;
			}
			if (Date.now() >= deadline) throw new ArchilError(`Image ${image.imageId} was not ready after ${timeoutSeconds} seconds`, 408, "IMAGE_BUILD_TIMEOUT");
			await new Promise((resolve) => setTimeout(resolve, pollMs));
			pollMs = Math.min(pollMs * 2, MAX_POLL_MS);
			image = await this.get(image.imageId);
			if (image.status === "building" && Date.now() - lastRequest >= REQUEST_AGAIN_MS) {
				image = await this._request(request);
				lastRequest = Date.now();
			}
		}
	}
	async _request(request) {
		return imageFromWire(await unwrap(retryApiRequest(() => this._client.POST("/api/images", { body: {
			source: request.source,
			registry_auth: request.registryAuth
		} }), "transient")));
	}
};
//#endregion
//#region src/process-output-buffer.ts
/**
* Output each process has received but its iterator has not taken yet.
* Flow control bounds it to one channel window per process, so it never
* needs to refuse output.
*/
var ProcessOutputBuffer = class {
	queues = /* @__PURE__ */ new Map();
	has(subscription) {
		return !!this.queues.get(subscription)?.length;
	}
	push(subscription, output) {
		const queue = this.queues.get(subscription) ?? [];
		queue.push(output);
		this.queues.set(subscription, queue);
	}
	take(subscription) {
		const queue = this.queues.get(subscription);
		const output = queue?.shift();
		if (queue && !queue.length) this.queues.delete(subscription);
		return output;
	}
	discard(subscription) {
		this.queues.delete(subscription);
	}
};
//#endregion
//#region src/process-connection.ts
async function waitForSocketOpen(socket) {
	if (socket.readyState === WebSocket.OPEN) return;
	await new Promise((resolve, reject) => {
		const cleanup = () => {
			socket.removeEventListener("open", opened);
			socket.removeEventListener("error", failed);
			socket.removeEventListener("close", closed);
		};
		const opened = () => {
			cleanup();
			resolve();
		};
		const failed = () => {
			cleanup();
			reject(/* @__PURE__ */ new Error("Process connection failed"));
		};
		const closed = () => {
			cleanup();
			reject(/* @__PURE__ */ new Error("Process connection closed before opening"));
		};
		socket.addEventListener("open", opened, { once: true });
		socket.addEventListener("error", failed, { once: true });
		socket.addEventListener("close", closed, { once: true });
	});
}
async function openProcessSocket(connectionUrl) {
	for (let attempt = 0;; attempt++) {
		const url = await connectionUrl();
		let socket;
		try {
			socket = new WebSocket(url, PROTOCOL);
			socket.binaryType = "arraybuffer";
			await waitForSocketOpen(socket);
			return socket;
		} catch (error) {
			try {
				socket?.close();
			} catch {}
			if (attempt >= 3) throw new Error(`Process connection failed after ${attempt + 1} attempts`, { cause: error });
		}
		await retrySleep(attempt);
	}
}
/** Bound queued socket writes across all channels of a connection. */
async function waitForProcessWrite(socket) {
	while (socket.bufferedAmount > 256 * 1024) {
		if (socket.readyState !== WebSocket.OPEN) throw new Error("Process is disconnected");
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}
const PROTOCOL = "archil-process-v2";
const MAX_DATA = _archildata_api_types_process.Limits.MAX_DATA_BYTES;
const INITIAL_WINDOW = _archildata_api_types_process.Limits.INITIAL_WINDOW;
const MIN_DATA_COST = _archildata_api_types_process.Limits.MIN_DATA_COST;
const dataCost = (length) => Math.max(length, MIN_DATA_COST);
const MAX_CHANNELS = 128;
const IDLE_MS = 5e3;
/** Owns only the client connection. A disconnected transport never retries START. */
var ProcessConnection = class {
	url;
	opening;
	binary;
	generation = 0;
	constructor(url) {
		this.url = url;
	}
	async open() {
		if (this.binary?.canOpen) return this.binary.channel();
		if (!this.opening) {
			const opening = this.connect().finally(() => {
				if (this.opening === opening) this.opening = void 0;
			});
			this.opening = opening;
		}
		return (await this.opening).channel();
	}
	async connect() {
		const generation = this.generation;
		const socket = await openProcessSocket(this.url);
		if (generation !== this.generation) {
			socket.close();
			throw new Error("Process connection opening cancelled");
		}
		if (socket.protocol !== PROTOCOL) {
			socket.close();
			throw new Error(`Sandbox runtime does not support the ${PROTOCOL} process protocol`);
		}
		const binary = new BinaryConnection(socket);
		this.binary = binary;
		return binary;
	}
	disconnect() {
		this.generation++;
		this.opening = void 0;
		this.binary?.close();
		this.binary = void 0;
	}
};
var BinaryConnection = class {
	socket;
	channels = /* @__PURE__ */ new Map();
	next = 1;
	draining = false;
	idle;
	get canOpen() {
		return !this.draining && this.socket.readyState === WebSocket.OPEN && this.next < 4294967295 && this.channels.size < MAX_CHANNELS;
	}
	constructor(socket) {
		this.socket = socket;
		socket.addEventListener("message", (message) => {
			try {
				const frame = (0, _bufbuild_protobuf.fromBinary)(_archildata_api_types_process.ServerFrameSchema, new Uint8Array(message.data));
				if (frame.channelId === 0) {
					if (frame.body.case !== "drain") return;
					this.draining = true;
					if (!this.channels.size) this.close();
				} else this.channels.get(frame.channelId)?.receive(frame);
			} catch (error) {
				this.close(error);
			}
		});
		socket.addEventListener("close", () => this.close(/* @__PURE__ */ new Error("Process connection closed before exit")), { once: true });
		socket.addEventListener("error", () => this.close(/* @__PURE__ */ new Error("Process connection failed")), { once: true });
	}
	channel() {
		if (!this.canOpen) throw new Error("Process connection is draining or full");
		clearTimeout(this.idle);
		const channel = new BinaryChannel(this, this.next++);
		this.channels.set(channel.id, channel);
		return channel;
	}
	send(id, body) {
		this.socket.send((0, _bufbuild_protobuf.toBinary)(_archildata_api_types_process.ClientFrameSchema, (0, _bufbuild_protobuf.create)(_archildata_api_types_process.ClientFrameSchema, {
			channelId: id,
			body
		})));
	}
	async writable() {
		await waitForProcessWrite(this.socket);
	}
	remove(id) {
		this.channels.delete(id);
		if (!this.channels.size) if (this.draining) this.close();
		else this.idle = setTimeout(() => this.close(), IDLE_MS);
	}
	close(reason) {
		this.draining = true;
		clearTimeout(this.idle);
		for (const channel of [...this.channels.values()]) channel.finish(reason);
		if (this.socket.readyState < WebSocket.CLOSING) this.socket.close();
	}
};
/** @internal WebSocket-shaped channel; generated protobuf owns all wire encoding. */
var BinaryChannel = class {
	connection;
	id;
	readyState = WebSocket.OPEN;
	binaryType = "arraybuffer";
	events = new EventTarget();
	addEventListener = this.events.addEventListener.bind(this.events);
	sending = Promise.resolve();
	/** Stdin the runtime will accept. */
	sendCredit = INITIAL_WINDOW;
	/** Output the runtime may still send. */
	receiveCredit = INITIAL_WINDOW;
	/** Output consumed since credit was last returned. */
	consumed = 0;
	creditChanged;
	constructor(connection, id) {
		this.connection = connection;
		this.id = id;
	}
	sendRequest(request) {
		switch (request.type) {
			case "start": {
				const terminal = request.terminal === true ? {
					rows: 24,
					cols: 80
				} : request.terminal || void 0;
				this.connection.send(this.id, (0, _bufbuild_protobuf.create)(_archildata_api_types_process.ClientFrameSchema, { body: {
					case: "start",
					value: {
						command: request.command,
						cwd: request.cwd,
						terminal,
						env: request.env,
						timeoutSeconds: request.timeout_seconds === void 0 ? void 0 : BigInt(request.timeout_seconds)
					}
				} }).body);
				break;
			}
			case "attach":
				this.connection.send(this.id, (0, _bufbuild_protobuf.create)(_archildata_api_types_process.ClientFrameSchema, { body: {
					case: "attach",
					value: {
						processId: request.process_id,
						offset: BigInt(request.offset)
					}
				} }).body);
				break;
			case "kill":
				this.connection.send(this.id, (0, _bufbuild_protobuf.create)(_archildata_api_types_process.ClientFrameSchema, { body: {
					case: "kill",
					value: { processId: request.process_id }
				} }).body);
				break;
			case "resize":
				this.connection.send(this.id, (0, _bufbuild_protobuf.create)(_archildata_api_types_process.ClientFrameSchema, { body: {
					case: "resize",
					value: {
						processId: request.process_id,
						terminal: {
							rows: request.rows,
							cols: request.cols
						}
					}
				} }).body);
				break;
		}
	}
	send(bytes) {
		const sending = this.sending.then(async () => {
			for (let offset = 0; offset < bytes.length; offset += MAX_DATA) {
				const chunk = bytes.subarray(offset, offset + MAX_DATA);
				while (this.sendCredit < dataCost(chunk.length)) {
					if (this.readyState !== WebSocket.OPEN) throw new Error("Process is disconnected");
					await new Promise((resolve) => {
						this.creditChanged = resolve;
					});
				}
				if (this.readyState !== WebSocket.OPEN) throw new Error("Process is disconnected");
				this.sendCredit -= dataCost(chunk.length);
				this.connection.send(this.id, {
					case: "stdin",
					value: chunk
				});
				await this.connection.writable();
			}
		});
		this.sending = sending.catch(() => {});
		return sending;
	}
	/** Returns credit for output the application has taken. */
	release(cost) {
		if (this.readyState === WebSocket.CLOSED) return;
		this.consumed += cost;
		if (this.consumed < INITIAL_WINDOW / 2) return;
		this.receiveCredit += this.consumed;
		this.connection.send(this.id, {
			case: "windowUpdate",
			value: (0, _bufbuild_protobuf.create)(_archildata_api_types_process.WindowUpdateSchema, { bytes: this.consumed })
		});
		this.consumed = 0;
	}
	async closeStdin() {
		await this.sending;
		if (this.readyState !== WebSocket.OPEN) throw new Error("Process is disconnected");
		this.connection.send(this.id, (0, _bufbuild_protobuf.create)(_archildata_api_types_process.ClientFrameSchema, { body: {
			case: "closeStdin",
			value: {}
		} }).body);
	}
	close() {
		if (this.readyState !== WebSocket.OPEN) return;
		this.readyState = WebSocket.CLOSING;
		this.connection.send(this.id, (0, _bufbuild_protobuf.create)(_archildata_api_types_process.ClientFrameSchema, { body: {
			case: "detach",
			value: {}
		} }).body);
	}
	receive(frame) {
		const body = frame.body;
		let event;
		switch (body.case) {
			case "started":
			case "attached":
				event = {
					type: body.case,
					process_id: body.value.processId
				};
				break;
			case "windowUpdate":
				this.sendCredit += body.value.bytes;
				this.creditChanged?.();
				return;
			case "stdout":
			case "stderr": {
				if (body.value.data.length > MAX_DATA) throw new Error("Process output exceeds chunk size");
				const cost = dataCost(body.value.data.length);
				if (cost > this.receiveCredit) throw new Error("Process output exceeded its flow-control window");
				this.receiveCredit -= cost;
				const offset = Number(body.value.offset);
				if (!Number.isSafeInteger(offset)) {
					this.fail("output_offset_overflow", "Process offset exceeds JavaScript integer precision");
					return;
				}
				this.events.dispatchEvent(new MessageEvent("message", { data: {
					stream: body.case,
					offset,
					data: body.value.data,
					cost
				} }));
				return;
			}
			case "exit": {
				const status = {
					[_archildata_api_types_process.Exit_Status.COMPLETED]: "completed",
					[_archildata_api_types_process.Exit_Status.FAILED]: "failed",
					[_archildata_api_types_process.Exit_Status.CANCELLED]: "cancelled",
					[_archildata_api_types_process.Exit_Status.TIMED_OUT]: "timed_out"
				}[body.value.status];
				if (!status) {
					this.fail("unsupported_exit_status", `Unknown process exit status ${body.value.status}`);
					return;
				}
				event = {
					type: "exit",
					status,
					exit_code: body.value.exitCode,
					exit_reason: body.value.exitReason,
					cursor: Number(body.value.cursor)
				};
				break;
			}
			case "error":
				event = {
					type: "error",
					error: body.value.code,
					message: body.value.message
				};
				break;
			case "killed":
			case "resized":
				event = { type: body.case };
				break;
			case "detached":
				this.finish();
				return;
			case void 0: return;
			default: throw new Error("Unexpected process channel message");
		}
		this.events.dispatchEvent(new MessageEvent("message", { data: event }));
		if ([
			"exit",
			"error",
			"killed",
			"resized"
		].includes(body.case)) this.finish();
	}
	/** Fails only this channel, for a message whose value it cannot represent. */
	fail(error, message) {
		if (this.readyState === WebSocket.OPEN) this.connection.send(this.id, (0, _bufbuild_protobuf.create)(_archildata_api_types_process.ClientFrameSchema, { body: {
			case: "detach",
			value: {}
		} }).body);
		this.events.dispatchEvent(new MessageEvent("message", { data: {
			type: "error",
			error,
			message
		} }));
		this.finish();
	}
	finish(reason) {
		if (this.readyState === WebSocket.CLOSED) return;
		if (reason) this.events.dispatchEvent(new MessageEvent("message", { data: {
			type: "error",
			error: "connection_closed",
			message: String(reason)
		} }));
		this.readyState = WebSocket.CLOSED;
		this.creditChanged?.();
		this.connection.remove(this.id);
		this.events.dispatchEvent(new Event("close"));
	}
};
//#endregion
//#region src/sandbox-process.ts
/** @deprecated Use Sandbox.run() and Sandbox.attach(). Removed in the next version. */
var SandboxProcesses = class {
	_sandbox;
	_disconnect;
	/** @internal */
	constructor(_sandbox, _disconnect) {
		this._sandbox = _sandbox;
		this._disconnect = _disconnect;
	}
	/** @deprecated Use sandbox.run(). Removed in the next version. */
	start(command, options = {}) {
		return this._sandbox.run(command, options);
	}
	/** @deprecated Use sandbox.attach(). Removed in the next version. */
	connect(processId, options = {}) {
		return this._sandbox.attach(processId, options);
	}
	/** Disconnect process transport without terminating guest processes. */
	async disconnect() {
		this._disconnect();
	}
};
var SandboxProcess = class {
	_collectOutput;
	_buffer;
	_openConnection;
	_controlProcess;
	status = "running";
	stdout = "";
	stderr = "";
	_id;
	_cursor;
	_deliveredCursor;
	_stdoutDecoder = new TextDecoder();
	_stderrDecoder = new TextDecoder();
	_socket;
	_closed;
	_manual = false;
	_stdinClosed = false;
	_iteratorTaken = false;
	_wake;
	_error;
	_exit;
	_result;
	/** Returns each buffered binary output's credit once the iterator takes it. */
	_releases = /* @__PURE__ */ new WeakMap();
	_resolveDone;
	_done = new Promise((resolve) => {
		this._resolveDone = resolve;
	});
	/** Pull output from the shared buffer. One iterator may consume each handle. */
	output = { [Symbol.asyncIterator]: () => {
		if (this._iteratorTaken) throw new Error("Process output already has a consumer");
		this._iteratorTaken = true;
		return this._iterateOutput();
	} };
	/** @internal */
	constructor(processId, cursor, _collectOutput, _buffer, _openConnection, _controlProcess) {
		this._collectOutput = _collectOutput;
		this._buffer = _buffer;
		this._openConnection = _openConnection;
		this._controlProcess = _controlProcess;
		this._id = processId;
		this._cursor = cursor;
		this._deliveredCursor = cursor;
	}
	get id() {
		return this._id;
	}
	/** Next byte after output accepted into the SDK buffer. */
	get cursor() {
		return this._cursor;
	}
	get connected() {
		return this._socket?.readyState === WebSocket.OPEN;
	}
	/** Resolves once the runtime has accepted the input; waits while the process is not reading. */
	async sendInput(data) {
		if (this._stdinClosed) throw new Error("Process stdin is closed");
		const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
		await this._openSocket().send(bytes);
	}
	async closeStdin() {
		if (this._stdinClosed) return;
		this._stdinClosed = true;
		try {
			await this._openSocket().closeStdin();
		} catch (error) {
			this._stdinClosed = false;
			throw error;
		}
	}
	async resize(size) {
		if (this.status !== "running") throw new Error("Process has exited");
		await this._controlProcess({
			type: "resize",
			process_id: this._id,
			...size
		});
	}
	async kill() {
		if (!this._exit) await this._controlProcess({
			type: "kill",
			process_id: this._id
		});
	}
	async disconnect() {
		this._manual = true;
		this._socket?.close();
		await this._closed;
		if (!this._exit) this._fail(/* @__PURE__ */ new Error("Process is disconnected"));
	}
	async wait() {
		if (!this._iteratorTaken) for await (const _output of this.output);
		await this._done;
		if (this._error) throw this._error;
		return this._result;
	}
	async *_iterateOutput() {
		try {
			while (true) {
				const output = this._buffer.take(this);
				if (output) {
					this._releases.get(output)?.();
					this._deliveredCursor = output.offset + output.data.length;
					if (this._collectOutput) this._appendText(output.stream, (output.stream === "stdout" ? this._stdoutDecoder : this._stderrDecoder).decode(output.data, { stream: true }));
					this._complete();
					yield output;
				} else {
					this._complete();
					if (this._error) throw this._error;
					if (this._exit) return;
					await new Promise((resolve) => {
						this._wake = resolve;
					});
					this._wake = void 0;
				}
			}
		} finally {
			if (!this._exit && !this._error) await this.disconnect();
			this._buffer.discard(this);
			this._cursor = this._deliveredCursor;
		}
	}
	/** @internal */
	async _connect(request) {
		const socket = await this._openConnection();
		if (this._manual) {
			socket.close();
			throw new Error("Process is disconnected");
		}
		this._socket = socket;
		let closed;
		this._closed = new Promise((resolve) => {
			closed = resolve;
		});
		const expected = request.type === "start" ? "started" : "attached";
		let settled = false;
		let resolveReady;
		let rejectReady;
		const ready = new Promise((resolve, reject) => {
			resolveReady = resolve;
			rejectReady = reject;
		});
		socket.addEventListener("message", (message) => {
			if (this._socket !== socket) return;
			try {
				const data = message.data;
				if ("stream" in data) {
					this._enqueueOutput(data.data, data.offset, data.stream, () => socket.release(data.cost));
					return;
				}
				const event = data;
				switch (event.type) {
					case "started":
					case "attached":
						if (event.type !== expected || this._id && this._id !== event.process_id) throw new Error("Unexpected process identity");
						this._id = event.process_id;
						settled = true;
						resolveReady();
						break;
					case "exit":
						this._exit = event;
						this.status = event.status;
						this._stdinClosed = true;
						this._complete();
						this._wake?.();
						break;
					case "error": throw new Error(`${event.error}: ${event.message}`);
				}
			} catch (error) {
				const failure = error instanceof Error ? error : new Error(String(error));
				if (!settled) rejectReady(failure);
				this._fail(failure);
				socket.close();
			}
		});
		socket.addEventListener("error", () => {
			const error = /* @__PURE__ */ new Error("Process connection failed");
			if (!settled) rejectReady(error);
			this._fail(error);
		});
		socket.addEventListener("close", () => {
			if (this._socket === socket) this._socket = void 0;
			closed();
			if (!settled) rejectReady(/* @__PURE__ */ new Error("Process connection closed before ready"));
			if (!this._exit && !this._manual) this._fail(/* @__PURE__ */ new Error("Process connection closed before exit"));
		}, { once: true });
		try {
			socket.sendRequest(request);
		} catch (error) {
			rejectReady(error instanceof Error ? error : new Error(String(error)));
			this._fail(error);
			socket.close();
		}
		await ready;
	}
	_openSocket() {
		if (this.status !== "running") throw new Error("Process has exited");
		if (!this.connected) throw new Error("Process is disconnected");
		return this._socket;
	}
	_fail(error) {
		this._error ??= error instanceof Error ? error : new Error(String(error));
		this._resolveDone();
		this._wake?.();
	}
	_complete() {
		if (!this._exit || this._buffer.has(this) || this._result) return;
		this._flushDecoders();
		this._result = {
			status: this._exit.status,
			exitCode: this._exit.exit_code ?? void 0,
			exitReason: this._exit.exit_reason ?? void 0,
			stdout: this.stdout,
			stderr: this.stderr
		};
		this._resolveDone();
	}
	/** `release` returns the output's flow-control credit once it is consumed. */
	_enqueueOutput(payload, offset, stream, release) {
		const end = offset + payload.byteLength;
		if (end <= this._cursor) {
			release();
			return;
		}
		if (offset > this._cursor) throw new Error(`Process output gap: expected offset ${this._cursor}, received ${offset}`);
		const skip = this._cursor - offset;
		const output = {
			stream,
			offset: this._cursor,
			data: payload.slice(skip)
		};
		this._buffer.push(this, output);
		this._releases.set(output, release);
		this._cursor = end;
		this._wake?.();
	}
	_appendText(stream, data) {
		if (stream === "stdout") this.stdout += data;
		else this.stderr += data;
	}
	_flushDecoders() {
		if (!this._collectOutput) return;
		this._appendText("stdout", this._stdoutDecoder.decode());
		this._appendText("stderr", this._stderrDecoder.decode());
	}
};
//#endregion
//#region src/sandbox-files.ts
const DOWNLOAD_CHUNK_BYTES = 512 * 1024;
const UPLOAD_COMMAND = `set -eu
mkdir -p "$ARCHIL_FILE_PARENT"
trap 'rm -f "$ARCHIL_FILE_TEMP"' EXIT HUP INT TERM
: > "$ARCHIL_FILE_TEMP"
cat > "$ARCHIL_FILE_TEMP"
chmod "$ARCHIL_FILE_MODE" "$ARCHIL_FILE_TEMP"
mv -f "$ARCHIL_FILE_TEMP" "$ARCHIL_FILE_TARGET"
trap - EXIT HUP INT TERM`;
const DOWNLOAD_COMMAND = `set -eu
trap 'rm -f "$ARCHIL_FILE_TEMP"' EXIT HUP INT TERM
exec 3< "$ARCHIL_FILE_PATH"
while IFS= read -r count; do
    dd bs="$count" count=1 <&3 > "$ARCHIL_FILE_TEMP" 2>/dev/null
    size=$(wc -c < "$ARCHIL_FILE_TEMP")
    printf '%s\n' "$size"
    cat "$ARCHIL_FILE_TEMP"
    [ "$size" -eq "$count" ] || break
done`;
var ProcessOutputReader = class {
	_buffer = /* @__PURE__ */ new Uint8Array();
	_cursor = 0;
	_stderrDecoder = new TextDecoder();
	_stderr = "";
	_process;
	_output;
	attach(process) {
		this._process = process;
		this._output = process.output[Symbol.asyncIterator]();
	}
	async readLine() {
		while (true) {
			const newline = this._buffer.indexOf(10);
			if (newline >= 0) {
				const line = this._buffer.slice(0, newline);
				this._buffer = this._buffer.slice(newline + 1);
				return line;
			}
			this._buffer = concat(this._buffer, await this._nextChunk());
		}
	}
	async read(size) {
		while (this._buffer.length < size) this._buffer = concat(this._buffer, await this._nextChunk());
		const data = this._buffer.slice(0, size);
		this._buffer = this._buffer.slice(size);
		return data;
	}
	async wait() {
		while (!(await this._output.next()).done);
		assertSuccessful(await this._process.wait(), this._stderr + this._stderrDecoder.decode());
	}
	async _nextChunk() {
		while (true) {
			const next = await this._output.next();
			if (next.done) {
				assertSuccessful(await this._process.wait(), this._stderr + this._stderrDecoder.decode());
				throw new Error("Sandbox process exited before file transfer completed");
			}
			const output = next.value;
			if (output.offset !== this._cursor) throw new Error(`Sandbox process output gap: expected offset ${this._cursor}, received ${output.offset}`);
			this._cursor += output.data.length;
			if (output.stream === "stdout") return output.data;
			this._stderr += this._stderrDecoder.decode(output.data, { stream: true });
		}
	}
};
var SandboxFiles = class {
	_sandbox;
	/** @internal */
	constructor(sandbox) {
		this._sandbox = sandbox;
	}
	async uploadFile(source, remotePath, options = {}) {
		const { path, parent } = remoteFilePath(remotePath);
		const mode = options.mode ?? 420;
		if (!Number.isInteger(mode) || mode < 0 || mode > 4095) throw new RangeError("mode must be between 0 and 0o7777");
		let process;
		try {
			process = await this._sandbox.run(UPLOAD_COMMAND, { env: {
				ARCHIL_FILE_PARENT: parent,
				ARCHIL_FILE_TARGET: path,
				ARCHIL_FILE_TEMP: `${parent}/.archil-upload-${transferId()}`,
				ARCHIL_FILE_MODE: mode.toString(8)
			} });
			for await (const chunk of fileChunks(source)) await process.sendInput(chunk);
			await process.closeStdin();
			assertSuccessful(await process.wait());
		} catch (error) {
			if (process) await abort(process);
			if (error instanceof RangeError || error instanceof TypeError) throw error;
			throw new SandboxFileTransferError("upload", path, toError(error));
		} finally {
			await process?.disconnect();
		}
	}
	async downloadFile(remotePath, write) {
		const { path } = remoteFilePath(remotePath);
		const reader = new ProcessOutputReader();
		let process;
		try {
			process = await this._sandbox.run(DOWNLOAD_COMMAND, {
				env: {
					ARCHIL_FILE_PATH: path,
					ARCHIL_FILE_TEMP: `/tmp/.archil-download-${transferId()}`
				},
				collectOutput: false
			});
			reader.attach(process);
			while (true) {
				await process.sendInput(`${DOWNLOAD_CHUNK_BYTES}\n`);
				const sizeText = new TextDecoder().decode(await reader.readLine()).trim();
				const size = Number(sizeText);
				if (!Number.isSafeInteger(size) || size < 0 || size > DOWNLOAD_CHUNK_BYTES) throw new Error(`Sandbox returned an invalid chunk size: ${JSON.stringify(sizeText)}`);
				if (size === 0) break;
				await write(await reader.read(size));
				if (size < DOWNLOAD_CHUNK_BYTES) break;
			}
			await reader.wait();
		} catch (error) {
			if (process) await abort(process);
			if (error instanceof RangeError || error instanceof TypeError) throw error;
			throw new SandboxFileTransferError("download", path, toError(error));
		} finally {
			await process?.disconnect();
		}
	}
};
async function* fileChunks(source) {
	if (source instanceof Uint8Array) {
		yield source;
		return;
	}
	if (source instanceof ArrayBuffer) {
		yield new Uint8Array(source);
		return;
	}
	if (source instanceof Blob) {
		yield* readableChunks(source.stream());
		return;
	}
	if (Symbol.asyncIterator in source) {
		for await (const chunk of source) yield new Uint8Array(chunk);
		return;
	}
	yield* readableChunks(source);
}
async function* readableChunks(source) {
	const reader = source.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) return;
			yield value;
		}
	} finally {
		reader.releaseLock();
	}
}
function remoteFilePath(path) {
	if (path.includes("\0")) throw new TypeError("remote path cannot contain NUL");
	if (!path.startsWith("/") || path.endsWith("/")) throw new TypeError("remote path must be an absolute file path");
	return {
		path,
		parent: path.slice(0, path.lastIndexOf("/")) || "/"
	};
}
function assertSuccessful(result, stderr = result.stderr) {
	if (result.status === "completed" && result.exitCode === 0) return;
	throw new Error(stderr.trim() || result.exitReason || `exit code ${String(result.exitCode)}`);
}
async function abort(process) {
	try {
		await process.kill();
	} catch {}
}
function transferId() {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
function concat(left, right) {
	const result = new Uint8Array(left.byteLength + right.byteLength);
	result.set(left);
	result.set(right, left.byteLength);
	return result;
}
function toError(error) {
	return error instanceof Error ? error : new Error(String(error));
}
//#endregion
//#region src/sandbox.ts
/** @internal */
function sandboxMountWire(mount) {
	const entry = {
		disk_id: typeof mount.disk === "string" ? mount.disk : mount.disk.id,
		read_only: mount.readOnly ?? false,
		conditional: mount.conditional ?? false
	};
	if (mount.path !== void 0) entry.path = mount.path;
	if (mount.subdirectory !== void 0) entry.subdirectory = mount.subdirectory;
	if (mount.queueMs !== void 0) entry.queue_ms = mount.queueMs;
	return entry;
}
function sandboxMountFromWire(mount) {
	const out = {
		diskId: mount.disk_id,
		path: mount.path,
		readOnly: mount.read_only ?? false,
		conditional: mount.conditional ?? false
	};
	if (mount.subdirectory !== void 0) out.subdirectory = mount.subdirectory;
	if (mount.queue_ms !== void 0) out.queueMs = mount.queue_ms;
	return out;
}
function portTokenFromWire(data) {
	return {
		id: data.id,
		port: data.port,
		createdAt: new Date(data.created_at),
		expiresAt: data.expires_at ? new Date(data.expires_at) : void 0
	};
}
const POLL_INTERVAL_MS = 500;
function sleep() {
	return new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
}
var Sandbox = class Sandbox {
	id;
	name;
	status;
	vcpuCount;
	memSizeMiB;
	baseImage;
	imageDigest;
	platform;
	maxTtlSeconds;
	idleTtlSeconds;
	maxConcurrentExecs;
	endpoints;
	mounts;
	createdAt;
	runningAt;
	finishedAt;
	lastActiveAt;
	exitReason;
	checkpoint;
	/** @deprecated Use run() and attach(). Removed in the next version. */
	processes;
	files;
	/** @internal */
	_client;
	_processConnection;
	_processOutput = new ProcessOutputBuffer();
	/** @internal */
	constructor(data, client) {
		this._client = client;
		this._apply(data);
		this._processConnection = new ProcessConnection(() => this._connectionUrl());
		this.processes = new SandboxProcesses(this, () => this._processConnection.disconnect());
		this.files = new SandboxFiles(this);
	}
	/** @internal Overwrite this sandbox's fields in place from a fresh wire snapshot. */
	_apply(data) {
		this.id = data.sandbox_id;
		this.name = data.name;
		this.status = data.status;
		this.vcpuCount = data.vcpu_count;
		this.memSizeMiB = data.mem_size_mib;
		this.baseImage = data.base_image;
		this.imageDigest = data.image_digest ?? "";
		this.platform = data.platform;
		this.maxTtlSeconds = data.max_ttl_seconds;
		this.idleTtlSeconds = data.idle_ttl_seconds ?? 0;
		this.maxConcurrentExecs = data.max_concurrent_execs;
		this.endpoints = data.endpoints?.map((endpoint) => ({ ...endpoint }));
		this.mounts = (data.mounts ?? []).map(sandboxMountFromWire);
		this.createdAt = new Date(data.created_at);
		this.runningAt = data.running_at ? new Date(data.running_at) : void 0;
		this.finishedAt = data.finished_at ? new Date(data.finished_at) : void 0;
		this.lastActiveAt = new Date(data.last_active_at);
		this.exitReason = data.exit_reason;
		this.checkpoint = data.checkpoint;
		return this;
	}
	toJSON() {
		return {
			id: this.id,
			name: this.name,
			status: this.status,
			vcpuCount: this.vcpuCount,
			memSizeMiB: this.memSizeMiB,
			baseImage: this.baseImage,
			imageDigest: this.imageDigest,
			platform: this.platform,
			maxTtlSeconds: this.maxTtlSeconds,
			idleTtlSeconds: this.idleTtlSeconds,
			maxConcurrentExecs: this.maxConcurrentExecs,
			endpoints: this.endpoints?.map((endpoint) => ({ ...endpoint })),
			mounts: this.mounts.map((mount) => ({ ...mount })),
			createdAt: this.createdAt,
			runningAt: this.runningAt,
			finishedAt: this.finishedAt,
			lastActiveAt: this.lastActiveAt,
			exitReason: this.exitReason,
			checkpoint: this.checkpoint
		};
	}
	/** Start a process and return its handle without waiting for exit. */
	async run(command, options = {}) {
		const process = new SandboxProcess("", 0, options.collectOutput ?? true, this._processOutput, () => this._processConnection.open(), (request) => this._control(request));
		const terminal = typeof options.terminal === "object" ? {
			cols: options.terminal.cols ?? 80,
			rows: options.terminal.rows ?? 24
		} : options.terminal;
		await process._connect({
			type: "start",
			command,
			cwd: options.cwd,
			terminal,
			env: options.env ?? {},
			timeout_seconds: options.timeoutSeconds
		});
		return process;
	}
	/** Reattach to a process, optionally resuming output from a cursor. */
	async attach(processId, options = {}) {
		const offset = options.offset ?? 0;
		const process = new SandboxProcess(processId, offset, options.collectOutput ?? true, this._processOutput, () => this._processConnection.open(), (request) => this._control(request));
		await process._connect({
			type: "attach",
			process_id: processId,
			offset
		});
		return process;
	}
	async _connectionUrl() {
		return (await unwrap(retryApiRequest(() => this._client.POST("/api/sandboxes/{sid}/connections", { params: { path: { sid: this.id } } }), "transient"))).url;
	}
	async _control(request) {
		const socket = await this._processConnection.open();
		const expected = request.type === "kill" ? "killed" : "resized";
		await new Promise((resolve, reject) => {
			socket.addEventListener("message", (message) => {
				try {
					const event = message.data;
					if (event.type === "error") reject(/* @__PURE__ */ new Error(`${event.error}: ${event.message}`));
					else if (event.type !== expected) reject(/* @__PURE__ */ new Error(`Expected ${expected}, received ${event.type}`));
					else resolve();
				} catch (error) {
					reject(error);
				} finally {
					socket.close();
				}
			}, { once: true });
			socket.addEventListener("error", () => reject(/* @__PURE__ */ new Error(`Process ${request.type} request failed`)));
			socket.addEventListener("close", () => reject(/* @__PURE__ */ new Error(`Process ${request.type} connection closed before confirmation`)));
			socket.sendRequest(request);
		});
	}
	/** Run a process and wait for it to exit. */
	async exec(command, options = {}) {
		return (await this.run(command, options)).wait();
	}
	/** Re-fetch this sandbox. */
	async refresh() {
		const data = await unwrap(retryApiRequest(() => this._client.GET("/api/sandboxes/{sid}", { params: { path: { sid: this.id } } }), "transient"));
		return this._apply(data);
	}
	/** Start this sandbox. */
	async start(options = {}) {
		const data = await unwrap(retryApiRequest(() => this._client.POST("/api/sandboxes/{sid}/start", {
			params: {
				path: { sid: this.id },
				query: { wait: options.wait ?? true }
			},
			...options.mounts !== void 0 && { body: { mounts: options.mounts.map(sandboxMountWire) } }
		}), options.mounts === void 0 ? "transient" : "connect"));
		this._apply(data);
		return options.wait === false ? this : waitForSandboxStart(this);
	}
	/** Stop this sandbox. */
	async stop(options = {}) {
		const data = await unwrap(retryApiRequest(() => this._client.POST("/api/sandboxes/{sid}/stop", { params: { path: { sid: this.id } } }), "transient"));
		this._apply(data);
		return options.wait === false ? this : waitWhileSandboxStatus(this, "stopping");
	}
	/** Pause this sandbox, preserving its CPU and memory state. */
	async pause(options = {}) {
		const data = await unwrap(retryApiRequest(() => this._client.POST("/api/sandboxes/{sid}/pause", { params: { path: { sid: this.id } } }), "transient"));
		this._apply(data);
		if (options.wait === false) return this;
		await waitWhileSandboxStatus(this, "pausing");
		if (this.status !== "paused") throw new SandboxPauseError(this);
		return this;
	}
	/** Resume this sandbox from its preserved CPU and memory state. */
	async resume(options = {}) {
		const data = await unwrap(retryApiRequest(() => this._client.POST("/api/sandboxes/{sid}/resume", { params: {
			path: { sid: this.id },
			query: { wait: options.wait ?? true }
		} }), "transient"));
		this._apply(data);
		return options.wait === false ? this : waitForSandboxStart(this);
	}
	/**
	* Create an isolated writable branch from this sandbox's current state.
	* A running sandbox is paused for the snapshot and resumed once the fork is
	* accepted; a paused or stopped sandbox is left as it is. The fork names the
	* checkpoint the pause returned, so it does not depend on the source still
	* being paused when the request lands. Resuming the source is best effort:
	* the child is returned even if the source could not be resumed, so check
	* the source's status afterwards if that matters.
	*/
	async fork(options = {}) {
		const paused = await unwrap(retryApiRequest(() => this._client.POST("/api/sandboxes/{sid}/pause", { params: { path: { sid: this.id } } }), "transient"));
		this._apply(paused);
		const resumeAfterFork = this.status === "pausing";
		const checkpoint = this.checkpoint;
		const wait = resumeAfterFork ? false : options.wait ?? true;
		const body = {
			name: options.name,
			checkpoint
		};
		const fork = await waitWhileSandboxStatus(this, "pausing").then(() => unwrap(retryApiRequest(() => this._client.POST("/api/sandboxes/{sid}/fork", {
			params: {
				path: { sid: this.id },
				query: { wait }
			},
			body
		}), "connect"))).then((data) => new Sandbox(data, this._client)).finally(() => resumeAfterFork ? this.resume({ wait: false }).catch(() => void 0) : void 0);
		if (options.wait === false) return fork;
		await waitForSandboxStart(fork);
		if (resumeAfterFork) await waitForSandboxStart(this).catch(() => void 0);
		return fork;
	}
	/** Expose a TCP port publicly (1–65535), returning its hostname. */
	async exposePort(port) {
		const client = this._client;
		return (await unwrap(retryApiRequest(() => client.PUT("/api/sandboxes/{sid}/ports/{port}", { params: { path: {
			sid: this.id,
			port
		} } }), "transient"))).hostname;
	}
	/** List explicitly exposed public ports. Service-published ports are in `endpoints`. */
	async listPorts() {
		const client = this._client;
		return (await unwrap(retryApiRequest(() => client.GET("/api/sandboxes/{sid}/ports", { params: { path: { sid: this.id } } }), "transient"))).ports;
	}
	/** Remove explicit public exposure. A service publishing the same port remains reachable. */
	async unexposePort(port) {
		const client = this._client;
		await unwrapEmpty(retryApiRequest(() => client.DELETE("/api/sandboxes/{sid}/ports/{port}", { params: { path: {
			sid: this.id,
			port
		} } }), "transient"));
	}
	/** Authorize HTTP access to one port without making it public. */
	async createPortToken(port, options = {}) {
		const data = await unwrap(retryApiRequest(() => this._client.POST("/api/sandboxes/{sid}/port-tokens", {
			params: { path: { sid: this.id } },
			body: {
				port,
				ttl: options.ttl
			}
		}), "connect"));
		return {
			...portTokenFromWire(data),
			hostname: data.hostname,
			token: data.token
		};
	}
	/** Get token metadata. Expired and revoked tokens return not found. */
	async getPortToken(tokenId) {
		return portTokenFromWire(await unwrap(retryApiRequest(() => this._client.GET("/api/sandboxes/{sid}/port-tokens/{token_id}", { params: { path: {
			sid: this.id,
			token_id: tokenId
		} } }), "transient")));
	}
	/** List token metadata across pages. `limit` caps the total number returned. */
	async listPortTokens(options = {}) {
		const tokens = [];
		let cursor = options.cursor;
		for (;;) {
			const remaining = options.limit === void 0 ? void 0 : options.limit - tokens.length;
			if (remaining !== void 0 && remaining <= 0) return tokens;
			const page = await this.listPortTokensPage({
				limit: remaining === void 0 ? 100 : Math.min(remaining, 100),
				cursor
			});
			tokens.push(...page.tokens);
			if (!page.nextCursor) return tokens;
			cursor = page.nextCursor;
		}
	}
	/** Fetch one page of token metadata; pass `nextCursor` back as `cursor`. */
	async listPortTokensPage(options = {}) {
		const { data, nextCursor } = await unwrapPage(retryApiRequest(() => this._client.GET("/api/sandboxes/{sid}/port-tokens", { params: {
			path: { sid: this.id },
			query: {
				limit: options.limit ?? 100,
				cursor: options.cursor
			}
		} }), "transient"));
		return {
			tokens: data.tokens.map(portTokenFromWire),
			nextCursor
		};
	}
	/** Revoke a token for new connections. Existing connections remain open. */
	async deletePortToken(token) {
		const tokenId = typeof token === "string" ? token : token.id;
		await unwrapEmpty(retryApiRequest(() => this._client.DELETE("/api/sandboxes/{sid}/port-tokens/{token_id}", { params: { path: {
			sid: this.id,
			token_id: tokenId
		} } }), "transient"));
	}
	/** Get this running sandbox's effective network policy. */
	async getNetwork() {
		const client = this._client;
		return unwrap(retryApiRequest(() => client.GET("/api/sandboxes/{sid}/network", { params: { path: { sid: this.id } } }), "transient"));
	}
	/** Replace this running sandbox's complete network policy and return the effective policy. */
	async updateNetwork(network) {
		const client = this._client;
		return unwrap(retryApiRequest(() => client.PUT("/api/sandboxes/{sid}/network", {
			params: { path: { sid: this.id } },
			body: network
		}), "transient"));
	}
	/** Update either or both TTLs in seconds. Omitted settings remain unchanged. */
	async setTimeout(timeout) {
		const options = typeof timeout === "number" ? { timeoutSeconds: timeout } : timeout;
		const client = this._client;
		const data = await unwrap(retryApiRequest(() => client.POST("/api/sandboxes/{sid}/timeout", {
			params: { path: { sid: this.id } },
			body: {
				timeout: options.timeoutSeconds,
				idle_ttl_seconds: options.idleTtlSeconds
			}
		}), "transient"));
		return this._apply(data);
	}
	/** Delete this sandbox and its backing disk. */
	async delete() {
		await unwrapEmpty(retryApiRequest(() => this._client.DELETE("/api/sandboxes/{sid}", { params: { path: { sid: this.id } } }), "transient"));
	}
};
/** @internal Continue waiting if the server returned before startup completed. */
async function waitForSandboxStart(sandbox) {
	return waitWhileSandboxStatus(sandbox, "pending");
}
async function waitWhileSandboxStatus(sandbox, status) {
	while (sandbox.status === status) {
		await sleep();
		await sandbox.refresh();
	}
	return sandbox;
}
//#endregion
//#region src/sandboxes.ts
var Sandboxes = class {
	/** @internal */
	_client;
	/** @internal */
	constructor(client) {
		this._client = client;
	}
	/** List the account's sandboxes, oldest first. */
	async list(options = {}) {
		const filesystem = typeof options.disk === "string" ? options.disk : options.disk?.id;
		return ((await unwrap(retryApiRequest(() => this._client.GET("/api/sandboxes", { params: { query: { filesystem } } }), "transient")))?.sandboxes ?? []).map((sandbox) => new Sandbox(sandbox, this._client));
	}
	async get(id) {
		return new Sandbox(await unwrap(retryApiRequest(() => this._client.GET("/api/sandboxes/{sid}", { params: { path: { sid: id } } }), "transient")), this._client);
	}
	async create(request = {}, options = {}) {
		const body = {
			name: request.name,
			vcpu_count: request.vcpuCount,
			mem_size_mib: request.memSizeMiB,
			base_image: request.baseImage,
			image_id: request.imageId,
			env: request.env,
			max_ttl_seconds: request.maxTtlSeconds,
			idle_ttl_seconds: request.idleTtlSeconds,
			max_concurrent_execs: request.maxConcurrentExecs,
			network: request.network,
			ports: request.ports,
			...request.mounts !== void 0 && { mounts: request.mounts.map(sandboxMountWire) }
		};
		const sandbox = new Sandbox(await unwrap(retryApiRequest(() => this._client.POST("/api/sandboxes", {
			params: { query: { wait: options.wait ?? true } },
			body
		}), "connect")), this._client);
		return options.wait === false ? sandbox : waitForSandboxStart(sandbox);
	}
};
//#endregion
//#region src/tokens.ts
var Tokens = class {
	/** @internal */
	_client;
	/** @internal */
	constructor(client) {
		this._client = client;
	}
	async list(opts) {
		return (await unwrap(retryApiRequest(() => this._client.GET("/api/tokens", { params: { query: {
			limit: opts?.limit,
			cursor: opts?.cursor
		} } }), "transient"))).tokens ?? [];
	}
	async create(req) {
		return await unwrap(retryApiRequest(() => this._client.POST("/api/tokens", { body: req }), "connect"));
	}
	async delete(id) {
		await unwrapEmpty(retryApiRequest(() => this._client.DELETE("/api/tokens/{tokenId}", { params: { path: { tokenId: id } } }), "connect"));
	}
};
//#endregion
//#region src/paths.ts
/**
* Normalize a filesystem path to its segments, resolving "." and ".." (so a
* path means the same as in a shell, and ".." can't escape above the root) and
* optionally stripping a shell-style mount prefix (e.g. "/mnt" or "/mnt/archil")
* so a path copied from a `run_bash` command resolves the same way.
*
*   toSegments("/a/b/../c")            -> ["a", "c"]
*   toSegments("/mnt/x", "/mnt")        -> ["x"]
*   toSegments("/../../etc/x")          -> ["etc", "x"]
*/
function toSegments(path, containerRoot) {
	let p = (path ?? "").trim();
	if (containerRoot) {
		const root = containerRoot.replace(/\/+$/, "");
		if (p === root) p = "/";
		else if (p.startsWith(root + "/")) p = p.slice(root.length);
	}
	const resolved = [];
	for (const seg of p.split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") resolved.pop();
		else resolved.push(seg);
	}
	return resolved;
}
//#endregion
//#region src/workspace.ts
function isExecMountSpec$1(m) {
	return typeof m === "object" && m !== null && "disk" in m;
}
/**
* A key-routed filesystem spanning several Archil disks. Each disk is mounted
* under a name and addressed as the first segment of a key (`<name>/...`);
* `getObject`, `putObject`, `deleteObject`, `listObjects`, and `grep` route to
* the right disk by that segment (and `listObjects` / `grep` fan out across all
* of them when the key/prefix doesn't name one). Implements the same
* {@link FileSystem} surface as a single {@link Disk}, so it works anywhere a
* disk does. Mounts can be changed at runtime with {@link addDisk} /
* {@link removeDisk}.
*/
var Workspace = class {
	client;
	mounts = /* @__PURE__ */ new Map();
	/** @internal Use `archil.workspace({ ... })`. */
	constructor(client, mounts) {
		this.client = client;
		for (const [name, value] of Object.entries(mounts)) this.addDisk(name, value);
		if (this.mounts.size === 0) throw new Error("workspace() needs at least one disk");
	}
	/** Mount (or replace) a disk at `name`; its objects are addressed as
	* `<name>/...`. Accepts a `Disk` or a mount spec (read-only / subdirectory /
	* conditional / delegation checkouts); a bare disk-id string is rejected —
	* fetch the disk first. */
	addDisk(name, disk) {
		const rel = name.replace(/^\/+|\/+$/g, "");
		if (!rel) throw new Error("workspace mount name must be non-empty");
		if (rel.includes("/")) throw new Error(`workspace mount name '${name}' must not contain '/'`);
		if (rel === "." || rel === "..") throw new Error(`workspace mount name '${name}' is reserved ('.' and '..' are path navigation, not disk names)`);
		let d;
		let readOnly = false;
		let subdirectory;
		let conditional = false;
		let queueMs;
		let checkoutPaths;
		if (isExecMountSpec$1(disk)) {
			d = disk.disk;
			readOnly = disk.readOnly ?? false;
			subdirectory = disk.subdirectory;
			conditional = disk.conditional ?? false;
			queueMs = disk.queueMs;
			checkoutPaths = disk.checkoutPaths;
		} else d = disk;
		if (typeof d === "string") throw new Error("workspace needs Disk objects, not disk-id strings; fetch with archil.getDisk(id) first");
		this.mounts.set(rel, {
			disk: d,
			readOnly,
			subdirectory,
			conditional,
			queueMs,
			checkoutPaths
		});
		return this;
	}
	/** Unmount the disk at `name`. Returns whether a disk was removed. Refuses to
	* remove the last disk — a workspace must always have at least one (the same
	* invariant the constructor enforces), else fan-out/exec would have nothing to
	* route to. */
	removeDisk(name) {
		const rel = name.replace(/^\/+|\/+$/g, "");
		if (this.mounts.has(rel) && this.mounts.size === 1) throw new Error("cannot remove the last disk from a workspace; a workspace must keep at least one");
		return this.mounts.delete(rel);
	}
	/** The names of the currently-mounted disks. */
	diskNames() {
		return [...this.mounts.keys()];
	}
	unknownDisk(name) {
		return /* @__PURE__ */ new Error(`No disk named '${name}'. Address objects by disk: ${this.diskNames().map((n) => `${n}/…`).join(", ")}`);
	}
	/** Resolve a workspace key (`<name>/...`) to the disk and the disk-relative key. */
	route(key) {
		const segs = toSegments(key);
		if (segs.length === 0) throw new Error("that key is the workspace root, not an object; name a disk, e.g. data/file.txt");
		const entry = this.mounts.get(segs[0]);
		if (!entry) throw this.unknownDisk(segs[0]);
		return {
			entry,
			diskKey: this.diskKey(entry, segs.slice(1).join("/"))
		};
	}
	/** Mounts touched by a key prefix; an empty prefix fans out to all of them. */
	covered(prefix) {
		const segs = toSegments(prefix);
		if (segs.length === 0) return [...this.mounts.entries()].map(([name, entry]) => ({
			name,
			entry,
			rel: this.diskKey(entry, "")
		}));
		const entry = this.mounts.get(segs[0]);
		if (!entry) throw this.unknownDisk(segs[0]);
		return [{
			name: segs[0],
			entry,
			rel: this.diskKey(entry, segs.slice(1).join("/"))
		}];
	}
	/** Map a workspace-relative key to the disk's key, applying the mount's subdirectory. */
	diskKey(entry, rel) {
		const trimmed = rel.replace(/^\/+/, "");
		const sub = (entry.subdirectory ?? "").replace(/^\/+|\/+$/g, "");
		if (!sub) return trimmed;
		return trimmed ? `${sub}/${trimmed}` : sub;
	}
	/** Map a disk key back to its workspace key (`<name>/...`), stripping the mount subdirectory. */
	abs(name, entry, diskKey) {
		const sub = (entry.subdirectory ?? "").replace(/^\/+|\/+$/g, "");
		let rel = diskKey;
		if (sub && diskKey.startsWith(sub + "/")) rel = diskKey.slice(sub.length + 1);
		else if (sub && diskKey === sub) rel = "";
		rel = rel.replace(/^\/+|\/+$/g, "");
		return rel ? `${name}/${rel}` : name;
	}
	async getObject(key) {
		const { entry, diskKey } = this.route(key);
		return entry.disk.getObject(diskKey);
	}
	async putObject(key, body, options) {
		const { entry, diskKey } = this.route(key);
		if (entry.readOnly) throw new Error(`${key} is on a read-only disk and cannot be written.`);
		return entry.disk.putObject(diskKey, body, options);
	}
	async deleteObject(key) {
		const { entry, diskKey } = this.route(key);
		if (entry.readOnly) throw new Error(`${key} is on a read-only disk and cannot be deleted.`);
		await entry.disk.deleteObject(diskKey);
	}
	async listObjects(prefix, opts = {}) {
		if (toSegments(prefix ?? "").length === 0 && !opts.recursive) return {
			objects: [],
			commonPrefixes: this.diskNames().map((n) => `${n}/`).sort(),
			isTruncated: false,
			keyCount: 0
		};
		const covered = this.covered(prefix ?? "");
		const listings = await Promise.allSettled(covered.map(({ entry, rel }) => {
			const p = rel ? rel.endsWith("/") ? rel : `${rel}/` : void 0;
			return entry.disk.listObjects(p, { recursive: opts.recursive });
		}));
		const objects = [];
		const commonPrefixes = [];
		let isTruncated = false;
		let keyCount = 0;
		covered.forEach(({ name, entry }, i) => {
			const settled = listings[i];
			if (settled.status === "rejected") {
				isTruncated = true;
				return;
			}
			const listing = settled.value;
			for (const cp of listing.commonPrefixes) commonPrefixes.push(`${this.abs(name, entry, cp.replace(/\/+$/, ""))}/`);
			for (const obj of listing.objects) objects.push({
				...obj,
				key: this.abs(name, entry, obj.key)
			});
			isTruncated = isTruncated || listing.isTruncated;
			keyCount += listing.keyCount;
		});
		objects.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
		commonPrefixes.sort();
		return {
			objects,
			commonPrefixes,
			isTruncated,
			keyCount
		};
	}
	async grep(opts) {
		const covered = this.covered(opts.directory ?? "");
		const results = await Promise.allSettled(covered.map(({ entry, rel }) => entry.disk.grep({
			...opts,
			directory: rel
		})));
		const matches = [];
		let filesScanned = 0;
		let containersDispatched = 0;
		let computeSecondsUsed = 0;
		let durationMs = 0;
		let listingMs = 0;
		let grepMs = 0;
		const reasons = /* @__PURE__ */ new Set();
		covered.forEach(({ name, entry }, i) => {
			const settled = results[i];
			if (settled.status === "rejected") {
				reasons.add("list_failed");
				return;
			}
			const r = settled.value;
			filesScanned += r.filesScanned;
			containersDispatched += r.containersDispatched ?? 0;
			computeSecondsUsed += r.computeSecondsUsed ?? 0;
			durationMs = Math.max(durationMs, r.durationMs ?? 0);
			listingMs = Math.max(listingMs, r.listingMs ?? 0);
			grepMs = Math.max(grepMs, r.grepMs ?? 0);
			reasons.add(r.stoppedReason);
			for (const m of r.matches) matches.push({
				file: this.abs(name, entry, m.file),
				line: m.line,
				text: m.text
			});
		});
		const cap = opts.maxResults ?? 1e3;
		if (matches.length > cap) reasons.add("max_results");
		const priority = [
			"list_failed",
			"incomplete",
			"deadline",
			"max_results"
		];
		const stoppedReason = [...reasons].every((x) => x === "completed") ? "completed" : priority.find((x) => reasons.has(x)) ?? "completed";
		return {
			matches: matches.slice(0, cap),
			stoppedReason,
			filesScanned,
			containersDispatched,
			computeSecondsUsed,
			durationMs,
			listingMs,
			grepMs
		};
	}
	exec(command) {
		const disks = {};
		for (const [name, entry] of this.mounts) disks[name] = entry.readOnly || entry.subdirectory || entry.conditional || entry.queueMs !== void 0 || entry.checkoutPaths !== void 0 ? {
			disk: entry.disk,
			subdirectory: entry.subdirectory,
			readOnly: entry.readOnly,
			conditional: entry.conditional,
			queueMs: entry.queueMs,
			checkoutPaths: entry.checkoutPaths
		} : entry.disk;
		return this.client.exec({
			disks,
			command
		});
	}
};
//#endregion
//#region src/archil.ts
/**
* Read an environment variable in a way that is safe in browsers, where the
* `process` global does not exist. Returns undefined when there is no process
* environment, so the SDK can be bundled and run client-side as long as
* credentials are passed explicitly to `new Archil({ ... })`.
*/
function envVar(name) {
	return typeof process !== "undefined" && process.env ? process.env[name] : void 0;
}
function isExecMountSpec(m) {
	return typeof m === "object" && m !== null && "disk" in m;
}
function diskIdFromMount(m) {
	return typeof m === "string" ? m : m.id;
}
var Archil = class {
	disks;
	images;
	sandboxes;
	tokens;
	/** @internal */
	_client;
	constructor(opts = {}) {
		const apiKey = opts.apiKey ?? envVar("ARCHIL_API_KEY");
		const region = opts.region ?? envVar("ARCHIL_REGION");
		if (!apiKey) throw new Error("Missing API key: pass apiKey in options or set ARCHIL_API_KEY environment variable");
		if (!region) throw new Error("Missing region: pass region in options or set ARCHIL_REGION environment variable");
		const controlBaseUrl = opts.baseUrl ?? resolveBaseUrl(region);
		const client = createApiClient({
			apiKey,
			region,
			baseUrl: controlBaseUrl,
			tls: opts.tls
		});
		const s3BaseUrl = opts.s3BaseUrl ?? envVar("ARCHIL_S3_BASE_URL") ?? deriveS3BaseUrl(controlBaseUrl);
		this._client = client;
		this.disks = new Disks(client, region, s3BaseUrl);
		this.images = new Images(client);
		this.sandboxes = new Sandboxes(client);
		this.tokens = new Tokens(client);
	}
	/**
	* Run a command in a container with multiple disks mounted simultaneously,
	* each at its own relative path under `/mnt/archil`. Blocks until the
	* command completes and returns its stdout, stderr, exit code, and timing.
	*/
	async exec(opts) {
		const disks = {};
		for (const [relPath, mount] of Object.entries(opts.disks)) if (isExecMountSpec(mount)) {
			const entry = {
				disk: diskIdFromMount(mount.disk),
				readOnly: mount.readOnly ?? false,
				conditional: mount.conditional ?? false
			};
			if (mount.subdirectory !== void 0) entry.subdirectory = mount.subdirectory;
			if (mount.queueMs !== void 0) entry.queueMs = mount.queueMs;
			if (mount.checkoutPaths !== void 0) entry.checkoutPaths = mount.checkoutPaths;
			disks[relPath] = entry;
		} else disks[relPath] = diskIdFromMount(mount);
		return unwrap(retryApiRequest(() => this._client.POST("/api/exec", { body: {
			disks,
			command: opts.command
		} }), "connect"));
	}
	/**
	* Build an agent filesystem toolset spanning several disks at once. `mounts`
	* maps a relative path to a disk (or `ExecMountSpec`), exactly like
	* {@link exec}; each disk appears under `/mnt/archil/<path>`. Hand the result
	* to a framework adapter (`createDiskTools(workspace)`) to get tools that route
	* file operations by path and fan `grep`/`list_files` out across the disks.
	*/
	workspace(mounts) {
		return new Workspace(this, mounts);
	}
};
//#endregion
//#region src/index.ts
let _options;
let _instance;
function configure(options) {
	_options = options;
	_instance = void 0;
}
function archil() {
	if (!_instance) _instance = new Archil(_options);
	return _instance;
}
function createDisk(req) {
	return archil().disks.create(req);
}
function listDisks(opts) {
	return archil().disks.list(opts);
}
function getDisk(id) {
	return archil().disks.get(id);
}
function createSandbox(req = {}, opts = {}) {
	return archil().sandboxes.create(req, opts);
}
function listSandboxes(opts) {
	return archil().sandboxes.list(opts);
}
function getSandbox(id) {
	return archil().sandboxes.get(id);
}
function listApiKeys(opts) {
	return archil().tokens.list(opts);
}
function createApiKey(req) {
	return archil().tokens.create(req);
}
function deleteApiKey(id) {
	return archil().tokens.delete(id);
}
/**
* Run a command in a container with multiple disks mounted simultaneously,
* each at its own relative path under `/mnt/archil`. Blocks until the
* command completes and returns its stdout, stderr, exit code, and timing.
*/
function exec(opts) {
	return archil().exec(opts);
}
/**
* Build an agent filesystem toolset spanning several disks, using the
* module-level client. See {@link Archil.workspace}.
*/
function workspace(mounts) {
	return archil().workspace(mounts);
}
//#endregion
exports.Archil = Archil;
exports.ArchilApiError = ArchilApiError;
exports.ArchilError = ArchilError;
exports.ArchilS3Error = ArchilS3Error;
exports.Disk = Disk;
exports.DiskMultipart = DiskMultipart;
exports.Disks = Disks;
exports.ImageBuildError = ImageBuildError;
exports.Images = Images;
exports.Sandbox = Sandbox;
exports.SandboxFileTransferError = SandboxFileTransferError;
exports.SandboxFiles = SandboxFiles;
exports.SandboxPauseError = SandboxPauseError;
exports.SandboxProcess = SandboxProcess;
exports.SandboxProcesses = SandboxProcesses;
exports.Sandboxes = Sandboxes;
exports.Tokens = Tokens;
exports.USER_AGENT = USER_AGENT;
exports.VERSION = VERSION;
exports.Workspace = Workspace;
exports.configure = configure;
exports.createApiKey = createApiKey;
exports.createDisk = createDisk;
exports.createSandbox = createSandbox;
exports.deleteApiKey = deleteApiKey;
exports.effectiveUploadPartSize = effectiveUploadPartSize;
exports.exec = exec;
exports.getDisk = getDisk;
exports.getSandbox = getSandbox;
exports.listApiKeys = listApiKeys;
exports.listDisks = listDisks;
exports.listSandboxes = listSandboxes;
exports.workspace = workspace;
