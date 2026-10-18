import { createHmac } from "node:crypto";
import { isIP } from "node:net";

export const MAX_BODY_BYTES = 10_000;

export class InputError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export async function readSubmission(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new InputError("Content-Type must be application/json", 415);
  }
  if (request.headers.has("content-encoding") && request.headers.get("content-encoding") !== "identity") {
    throw new InputError("Compressed request bodies are not supported", 415);
  }
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    throw new InputError("Request body too large or invalid Content-Length", 413);
  }
  if (!request.body) throw new InputError("A JSON object is required", 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new InputError("Request body timed out", 408));
      void reader.cancel().catch(() => {});
    }, 5000);
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => {});
        throw new InputError("Request body too large", 413);
      }
      chunks.push(value);
    }
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid object");
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError("A valid JSON object is required", 400);
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

export function getSubmitterHash(request: Request): string | null {
  // Only Vercel's overwritten proxy header is trusted. Arbitrary forwarded
  // headers and user-agent strings must not let a caller reset the quota.
  if (process.env.VERCEL !== "1") return null;
  const address = request.headers.get("x-vercel-forwarded-for")?.trim().replace(/%.*$/, "");
  const salt = process.env.GUESTBOOK_HASH_SALT;
  if (!address || !isIP(address) || !salt || salt.length < 32) return null;
  // Do not reset this identity at midnight: the database uses a rolling hour.
  return createHmac("sha256", salt).update(quotaIdentity(address)).digest("hex");
}

// One IPv6 connection usually owns a whole /64, so individual addresses
// inside it must share a quota. IPv4-mapped IPv6 addresses count as IPv4.
export function quotaIdentity(address: string): string {
  if (isIP(address) === 4) return address;
  const groups = expandIPv6(address);
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join(".");
  }
  return groups.slice(0, 4).map((group) => group.toString(16)).join(":") + "::/64";
}

function expandIPv6(address: string): number[] {
  let value = address.toLowerCase();
  const dotted = value.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    value = value.slice(0, dotted.index) + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
  }
  const [head, tail] = value.split("::");
  const start = head ? head.split(":") : [];
  const end = tail ? tail.split(":") : [];
  const fill = tail === undefined ? [] : Array(8 - start.length - end.length).fill("0");
  return [...start, ...fill, ...end].map((group) => parseInt(group, 16));
}

// Postgres rejects NUL and unpaired surrogates, and counts code points rather
// than UTF-16 units. Bidi overrides and other controls can disguise text.
const disallowedInLine = /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/;
const disallowedInText = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/;

export function isCleanText(value: string, multiline: boolean): boolean {
  return value.isWellFormed() && !(multiline ? disallowedInText : disallowedInLine).test(value);
}

export function characterCount(value: string): number {
  return [...value].length;
}
