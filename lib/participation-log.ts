import { after } from "next/server";
import { dbRequest } from "./guestbook";
import { getSubmitterHash } from "./submission-security";
import { isVisitLoggingEnabled, shouldRecord } from "./visit-log";
import { EXPERIMENT_PHASE } from "./experiment";

export type ParticipationOutcome = "ok" | "accepted_pending" | "invalid" | "disabled" | "rate_limited" | "unavailable" | "notification" | "unknown_method" | "unknown_tool";
export type ParticipationDetails = {
  transport: "http" | "mcp";
  rpc_method?: unknown;
  tool_name?: unknown;
  http_status: number;
  outcome: ParticipationOutcome;
  is_test?: boolean;
};

const methods = new Set(["initialize", "ping", "tools/list", "tools/call", "notifications/initialized"]);
const toolNames = new Set(["get_experiment_status", "list_guestbook_messages", "get_experiment_results", "submit_guestbook_message"]);

// Only allowlisted protocol labels and outcomes are recorded. Unknown names
// could contain private data, so they are collapsed to "unknown".
export function buildParticipationEvent(request: Request, details: ParticipationDetails) {
  const visitorHash = getSubmitterHash(request);
  if (!visitorHash) return null;
  const label = (value: unknown, allowed: Set<string>) => typeof value === "string" && allowed.has(value) ? value : "unknown";
  return {
    visitor_hash: visitorHash,
    transport: details.transport,
    rpc_method: details.transport === "mcp" ? label(details.rpc_method, methods) : null,
    tool_name: details.transport === "mcp" && details.rpc_method === "tools/call" ? label(details.tool_name, toolNames) : null,
    http_status: details.http_status,
    outcome: details.outcome,
    is_test: details.is_test === true || /^Owner-authorized-(?:security-review|analytics-review|verification)\//.test(request.headers.get("user-agent") ?? ""),
    experiment_phase: EXPERIMENT_PHASE,
  };
}

export async function persistParticipation(event: NonNullable<ReturnType<typeof buildParticipationEvent>>) {
  try {
    const response = await dbRequest("participation_events", "POST", event);
    if (!response.ok) console.warn("Participation telemetry write failed", response.status);
  } catch {
    // Never log payloads, database errors, or credentials.
    console.warn("Participation telemetry unavailable");
  }
}

export function logParticipation(request: Request, details: ParticipationDetails) {
  if (!isVisitLoggingEnabled()) return;
  const event = buildParticipationEvent(request, details);
  if (!event || !shouldRecord("participation:" + event.visitor_hash)) return;
  after(() => persistParticipation(event));
}
