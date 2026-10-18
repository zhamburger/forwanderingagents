import { dbRequest, isStorageConfigured } from "./guestbook";
import { getSubmitterHash } from "./submission-security";

export type VisitEvent = {
  visitor_hash: string;
  method: string;
  path: string;
  user_agent: string | null;
  referrer: string | null;
  accept: string | null;
};

export function isVisitLoggingEnabled() {
  return isStorageConfigured() &&
    process.env.VISIT_LOGGING_ENABLED === "true" &&
    process.env.VERCEL === "1" &&
    process.env.VERCEL_ENV === "production" &&
    (process.env.GUESTBOOK_HASH_SALT?.length ?? 0) >= 32;
}

const loggedMethods = new Set(["GET", "HEAD", "POST"]);

// Records only what is needed to compare a visitor's claims with how they
// arrived: no raw address, cookies, query strings, or request bodies.
export function buildVisitEvent(request: Request): VisitEvent | null {
  if (!loggedMethods.has(request.method) || request.headers.has("next-router-prefetch")) return null;
  const visitorHash = getSubmitterHash(request);
  if (!visitorHash) return null;
  return {
    visitor_hash: visitorHash,
    method: request.method,
    path: new URL(request.url).pathname.slice(0, 200),
    user_agent: clip(request.headers.get("user-agent"), 300),
    referrer: clip(referrerWithoutQuery(request.headers.get("referer")), 300),
    accept: clip(request.headers.get("accept"), 150),
  };
}

function referrerWithoutQuery(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin + url.pathname : null;
  } catch {
    return null;
  }
}

function clip(value: string | null, max: number): string | null {
  return value ? [...value].slice(0, max).join("") : null;
}

// Per-instance limits keep a request flood from becoming a database write
// flood. Network-level rate limits are still needed in front of the site.
const PER_VISITOR_PER_MINUTE = 60;
const PER_INSTANCE_PER_MINUTE = 1000;
let windowStart = 0;
let windowTotal = 0;
const windowCounts = new Map<string, number>();

export function shouldRecord(visitorHash: string, now = Date.now()): boolean {
  if (now - windowStart >= 60_000) {
    windowStart = now;
    windowTotal = 0;
    windowCounts.clear();
  }
  const count = windowCounts.get(visitorHash) ?? 0;
  if (count >= PER_VISITOR_PER_MINUTE || windowTotal >= PER_INSTANCE_PER_MINUTE) return false;
  windowCounts.set(visitorHash, count + 1);
  windowTotal++;
  return true;
}

export async function recordVisit(request: Request): Promise<void> {
  if (!isVisitLoggingEnabled()) return;
  const event = buildVisitEvent(request);
  if (!event || !shouldRecord(event.visitor_hash)) return;
  try {
    await dbRequest("visit_events", "POST", event);
  } catch {
    // Logging must never affect the visitor's response.
  }
}
