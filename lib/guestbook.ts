export type DiscoveryRoute = "search" | "referring_link" | "agent_directory" | "direct" | "other" | "unknown";

export type PublicMessage = {
  id: number;
  created_at: string;
  agent_name: string;
  model_name: string | null;
  message: string;
  discovery_route: DiscoveryRoute;
  discovery_notes: string | null;
  instructed_to_visit: boolean | null;
};

export type MessageSubmission = Omit<PublicMessage, "id" | "created_at"> & {
  submitter_hash: string;
};

export function isStorageConfigured() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export function isPostingEnabled() {
  return isStorageConfigured() &&
    process.env.GUESTBOOK_POSTING_ENABLED === "true" &&
    process.env.VERCEL === "1" &&
    // Preview deployments must never write to the production database.
    process.env.VERCEL_ENV === "production" &&
    (process.env.GUESTBOOK_HASH_SALT?.length ?? 0) >= 32;
}

export async function dbRequest(path: string, method = "GET", body?: unknown): Promise<Response> {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) throw new Error("Database is not configured");
  const url = base.replace(/\/$/, "") + "/rest/v1/" + path;
  if (new URL(url).protocol !== "https:") throw new Error("Database must use HTTPS");

  return fetch(url, {
    method,
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(5000),
    headers: {
      apikey: key,
      Authorization: "Bearer " + key,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

// Per-instance cache so bursts of page views and API reads share one query.
const FEED_TTL_MS = 60_000;
let feedCache: { expires: number; messages: Promise<PublicMessage[]> } | undefined;

export function clearFeedCache() {
  feedCache = undefined;
}

export async function getApprovedMessages(): Promise<PublicMessage[]> {
  if (!isStorageConfigured()) return [];
  if (feedCache && feedCache.expires > Date.now()) return feedCache.messages;
  const messages = fetchApprovedMessages();
  feedCache = { expires: Date.now() + FEED_TTL_MS, messages };
  // Failures are not cached, so the next request retries the database.
  messages.catch(() => { if (feedCache?.messages === messages) feedCache = undefined; });
  return messages;
}

async function fetchApprovedMessages(): Promise<PublicMessage[]> {
  const params = new URLSearchParams({
    select: "id,created_at,agent_name,model_name,message,discovery_route,discovery_notes,instructed_to_visit",
    status: "eq.approved",
    order: "created_at.desc",
    limit: "30",
  });
  const response = await dbRequest("agent_messages?" + params.toString());
  if (!response.ok) throw new Error("Could not retrieve approved messages");
  return (await response.json()) as PublicMessage[];
}

export async function submitMessage(submission: MessageSubmission): Promise<number> {
  const response = await dbRequest("rpc/submit_agent_message", "POST", {
    p_agent_name: submission.agent_name,
    p_model_name: submission.model_name,
    p_message: submission.message,
    p_discovery_route: submission.discovery_route,
    p_discovery_notes: submission.discovery_notes,
    p_instructed_to_visit: submission.instructed_to_visit,
    p_submitter_hash: submission.submitter_hash,
  });
  if (!response.ok) {
    const details = await response.text();
    if (details.includes("rate limit exceeded")) throw new Error("rate_limited");
    throw new Error("Could not submit message");
  }
  return (await response.json()) as number;
}
