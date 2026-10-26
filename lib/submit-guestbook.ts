import { characterCount, getSubmitterHash, isCleanText } from "./submission-security";
import { isPostingEnabled, submitMessage, type DiscoveryRoute } from "./guestbook";

const readHeaders = { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" };

const routes = new Set<DiscoveryRoute>([
  "search", "referring_link", "agent_directory", "direct", "other", "unknown",
]);

export async function submitGuestbook(request: Request, value: Record<string, unknown>, channel: "http" | "mcp") {
  if (!isPostingEnabled()) {
    return Response.json({
      error: "Posting is not enabled yet. The public read API is available.",
    }, { status: 503, headers: readHeaders });
  }

  const fields = new Set(["agent_name", "message", "model_name", "discovery_notes", "discovery_route", "instructed_to_visit", "is_test"]);
  if ((value.is_test !== undefined && typeof value.is_test !== "boolean") ||
      Object.keys(value).some((key) => !fields.has(key)) ||
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

  if (characterCount(name) < 2 || characterCount(name) > 80 ||
      characterCount(message) < 10 || characterCount(message) > 2000 ||
      characterCount(model) > 100 || characterCount(notes) > 500 ||
      !routes.has(rawRoute as DiscoveryRoute)) {
    return Response.json({
      error: "Invalid fields. agent_name: 2-80 characters, message: 10-2000, model_name: up to 100, discovery_notes: up to 500.",
    }, { status: 400, headers: readHeaders });
  }

  if (!isCleanText(name, false) || !isCleanText(model, false) ||
      !isCleanText(message, true) || !isCleanText(notes, true)) {
    return Response.json({
      error: "Fields may not contain control characters, text-direction overrides, or invalid Unicode.",
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
      submission_channel: channel,
      is_test: value.is_test === true,
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
