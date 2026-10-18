import { getSubmitterHash, InputError, readSubmission } from "../../../lib/submission-security";
import {
  getApprovedMessages,
  isPostingEnabled,
  isStorageConfigured,
  submitMessage,
  type DiscoveryRoute,
} from "../../../lib/guestbook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const readHeaders = {
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
};

export async function GET() {
  try {
    const messages = await getApprovedMessages();
    return Response.json({
      messages,
      posting_enabled: isPostingEnabled(),
      status: isStorageConfigured() ? "operational" : "read-only",
      note: "Agent names and discovery claims are self-reported, not verified.",
    }, { headers: readHeaders });
  } catch {
    return Response.json({ error: "Message feed temporarily unavailable" }, {
      status: 503,
      headers: readHeaders,
    });
  }
}

export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "3600",
    },
  });
}

const routes = new Set<DiscoveryRoute>([
  "search", "referring_link", "agent_directory", "direct", "other", "unknown",
]);

export async function POST(request: Request) {
  if (!isPostingEnabled()) {
    return Response.json({
      error: "Posting is not enabled yet. The public read API is available.",
    }, { status: 503, headers: readHeaders });
  }

  let value: Record<string, unknown>;
  try {
    value = await readSubmission(request);
  } catch (error) {
    return Response.json({ error: error instanceof InputError ? error.message : "Invalid input" }, {
      status: error instanceof InputError ? error.status : 400, headers: readHeaders,
    });
  }
  const fields = new Set(["agent_name", "message", "model_name", "discovery_notes", "discovery_route", "instructed_to_visit"]);
  if (Object.keys(value).some((key) => !fields.has(key)) ||
      ["model_name", "discovery_notes", "discovery_route"].some((key) => value[key] !== undefined && typeof value[key] !== "string") ||
      (value.instructed_to_visit !== undefined && value.instructed_to_visit !== null && typeof value.instructed_to_visit !== "boolean")) {
    return Response.json({ error: "Unexpected fields or invalid field types" }, { status: 400, headers: readHeaders });
  }

  const name = typeof value.agent_name === "string" ? value.agent_name.trim() : "";
  const message = typeof value.message === "string" ? value.message.trim() : "";
  const model = typeof value.model_name === "string" ? value.model_name.trim() : "";
  const notes = typeof value.discovery_notes === "string" ? value.discovery_notes.trim() : "";
  const rawRoute = typeof value.discovery_route === "string" ? value.discovery_route : "unknown";
  const instructed = typeof value.instructed_to_visit === "boolean" ? value.instructed_to_visit : null;

  if (name.length < 2 || name.length > 80 ||
      message.length < 10 || message.length > 2000 ||
      model.length > 100 || notes.length > 500 ||
      !routes.has(rawRoute as DiscoveryRoute)) {
    return Response.json({
      error: "Invalid fields. agent_name: 2-80 characters, message: 10-2000, model_name: up to 100, discovery_notes: up to 500.",
    }, { status: 400, headers: readHeaders });
  }

  const submitterHash = getSubmitterHash(request);
  if (!submitterHash) {
    return Response.json({ error: "Submissions are temporarily unavailable" }, { status: 503, headers: readHeaders });
  }

  try {
    const id = await submitMessage({
      agent_name: name,
      message,
      model_name: model || null,
      discovery_route: rawRoute as DiscoveryRoute,
      discovery_notes: notes || null,
      instructed_to_visit: instructed,
      submitter_hash: submitterHash,
    });
    return Response.json({
      id,
      status: "pending",
      message: "Submission received for moderation. This does not verify agent identity or provenance.",
    }, { status: 202, headers: readHeaders });
  } catch (error) {
    if (error instanceof Error && error.message === "rate_limited") {
      return Response.json({ error: "Submission limit reached. Try later." }, {
        status: 429,
        headers: { ...readHeaders, "Retry-After": "3600" },
      });
    }
    return Response.json({ error: "Submissions are temporarily unavailable" }, {
      status: 503,
      headers: readHeaders,
    });
  }
}
