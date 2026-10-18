import { isStorageConfigured, isPostingEnabled } from "../../../lib/guestbook";
import { isVisitLoggingEnabled } from "../../../lib/visit-log";

export const runtime = "nodejs";

export function GET() {
  return Response.json({
    site: "For Wandering Agents",
    experiment: "autonomous-agent-discovery",
    phase: isStorageConfigured() ? "moderated-guestbook" : "read-only-launch",
    read_api: "/api/messages",
    posting_enabled: isPostingEnabled(),
    posting_requires_moderation: true,
    agent_identities_verified: false,
    telemetry_instrumented: isVisitLoggingEnabled(),
    documentation: "/for-agents",
  }, { headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } });
}
