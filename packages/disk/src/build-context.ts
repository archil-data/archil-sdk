export const MAX_CONTEXT_BYTES = 512 * 1024 * 1024;

// Node built-ins load when a context is packed, through a specifier bundlers can't
// resolve, so the browser bundle carries no reference to them.
const load = <T>(name: string): Promise<T> => import(/* @vite-ignore */ `node:${name}`) as Promise<T>;
const REGEX_SPECIALS = new Set([...".+()|{}$"]);

interface Pattern {
  regex: RegExp;
  exception: boolean;
}

// Docker's .dockerignore syntax (moby/patternmatcher): `*` and `?` stay within one
// path segment, `**` crosses any number of them, `\` escapes the next character.
function compile(pattern: string): RegExp {
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*" && pattern[i + 1] === "*") {
      i += 1;
      if (pattern[i + 1] === "/") i += 1;
      out += i + 1 === pattern.length ? ".*" : "(.*/)?";
    } else if (ch === "*") {
      out += "[^/]*";
    } else if (ch === "?") {
      out += "[^/]";
    } else if (ch === "\\" && i + 1 < pattern.length) {
      i += 1;
      out += pattern[i].replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    } else if (REGEX_SPECIALS.has(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`${out}$`);
}

async function readDockerignore(root: string): Promise<Pattern[]> {
  const { readFile } = await load<typeof import("node:fs/promises")>("fs/promises");
  const { join, posix } = await load<typeof import("node:path")>("path");
  let text: string;
  try {
    text = await readFile(join(root, ".dockerignore"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const patterns: Pattern[] = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith("#")) continue;
    const exception = line.startsWith("!");
    if (exception) line = line.slice(1).trim();
    line = posix.normalize(line).replace(/^\/+/, "");
    if (line && line !== ".") patterns.push({ regex: compile(line), exception });
  }
  return patterns;
}

/** Whether the last pattern matching `path` or one of its parents excludes it. */
function excluded(path: string, patterns: Pattern[]): boolean {
  const parts = path.split("/");
  let result = false;
  for (const pattern of patterns) {
    if (parts.some((_, n) => pattern.regex.test(parts.slice(0, n + 1).join("/")))) {
      result = !pattern.exception;
    }
  }
  return result;
}

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function header(name: string, type: string, mode: number, size: number, linkname = ""): Buffer {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100);
  block.write(octal(mode, 8), 100);
  block.write(octal(0, 8), 108);
  block.write(octal(0, 8), 116);
  block.write(octal(size, 12), 124);
  block.write(octal(0, 12), 136);
  block.write(" ".repeat(8), 148);
  block.write(type, 156);
  block.write(linkname, 157, 100);
  block.write("ustar\0", 257);
  block.write("00", 263);
  let checksum = 0;
  for (const byte of block) checksum += byte;
  block.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
  return block;
}

function pad(length: number): Buffer {
  return Buffer.alloc((512 - (length % 512)) % 512);
}

// Names or link targets that don't fit a ustar header travel in a PAX extended header.
function entry(name: string, type: string, mode: number, data: Buffer = Buffer.alloc(0), linkname = ""): Buffer[] {
  const records: string[] = [];
  const needsPax = (value: string, limit: number) => Buffer.byteLength(value) > limit || /[^\x20-\x7e]/.test(value);
  if (needsPax(name, 100)) records.push(paxRecord("path", name));
  if (needsPax(linkname, 100)) records.push(paxRecord("linkpath", linkname));
  const blocks: Buffer[] = [];
  if (records.length > 0) {
    const pax = Buffer.from(records.join(""));
    blocks.push(header("PaxHeader", "x", 0o644, pax.length), pax, pad(pax.length));
  }
  blocks.push(header(name, type, mode, data.length, linkname), data, pad(data.length));
  return blocks;
}

// A PAX record starts with its own length in bytes, digits included.
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  const bodyLength = Buffer.byteLength(body);
  let length = bodyLength;
  while (bodyLength + String(length).length !== length) length = bodyLength + String(length).length;
  return `${length}${body}`;
}

/**
 * Pack `directory` into a gzip-compressed tar and return it with its hex SHA-256.
 * Paths that `.dockerignore` excludes are left out, entries are sorted, and owners
 * and modification times are zeroed, so the same files always produce the same
 * archive and hash.
 */
export async function packContext(directory: string): Promise<{ data: Buffer; sha256: string }> {
  if (typeof process === "undefined" || !process.versions?.node) {
    throw new TypeError("A build context needs Node.js");
  }
  const { lstat, readdir, readFile, readlink, stat } = await load<typeof import("node:fs/promises")>("fs/promises");
  const { join } = await load<typeof import("node:path")>("path");
  const { createGzip } = await load<typeof import("node:zlib")>("zlib");
  const { once } = await load<typeof import("node:events")>("events");
  const { createHash } = await load<typeof import("node:crypto")>("crypto");
  if (!(await stat(directory).catch(() => undefined))?.isDirectory()) {
    throw new Error(`Build context ${directory} is not a directory`);
  }
  const patterns = await readDockerignore(directory);
  const canReinclude = patterns.some((pattern) => pattern.exception);
  const tooLarge = () =>
    new Error(`Build context ${directory} is over ${MAX_CONTEXT_BYTES / 1024 / 1024} MiB compressed`);
  const gzip = createGzip({ level: 9 });
  const chunks: Buffer[] = [];
  let compressed = 0;
  gzip.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
    compressed += chunk.length;
  });
  const finished = once(gzip, "end");
  const add = async (parts: Buffer[]) => {
    for (const part of parts) {
      if (!gzip.write(part)) await once(gzip, "drain");
    }
    if (compressed > MAX_CONTEXT_BYTES) throw tooLarge();
  };

  const walk = async (relative: string): Promise<void> => {
    const names = (await readdir(join(directory, relative))).sort();
    for (const name of names) {
      const child = relative ? `${relative}/${name}` : name;
      const full = join(directory, child);
      const info = await lstat(full);
      const isExcluded = excluded(child, patterns);
      if (info.isDirectory()) {
        if (!isExcluded) await add(entry(`${child}/`, "5", info.mode & 0o7777));
        if (!isExcluded || canReinclude) await walk(child);
      } else if (!isExcluded && info.isFile()) {
        await add(entry(child, "0", info.mode & 0o7777, await readFile(full)));
      } else if (!isExcluded && info.isSymbolicLink()) {
        await add(entry(child, "2", info.mode & 0o7777, undefined, await readlink(full)));
      }
    }
  };
  try {
    await walk("");
  } catch (error) {
    gzip.destroy();
    throw error;
  }
  gzip.end(Buffer.alloc(1024));
  await finished;
  const data = Buffer.concat(chunks);
  if (data.length > MAX_CONTEXT_BYTES) throw tooLarge();
  return { data, sha256: createHash("sha256").update(data).digest("hex") };
}
