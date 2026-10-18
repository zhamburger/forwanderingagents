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
  const address = request.headers.get("x-vercel-forwarded-for")?.trim();
  const salt = process.env.GUESTBOOK_HASH_SALT;
  if (!address || !isIP(address) || !salt || salt.length < 32) return null;
  const family = isIP(address);
  const normalized = family === 6 ? new URL(`http://[${address}]/`).hostname : address;
  // Do not reset this identity at midnight: the database uses a rolling hour.
  return createHmac("sha256", salt).update(normalized).digest("hex");
}
