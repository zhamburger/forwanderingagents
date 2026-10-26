import { EXPERIMENT_PHASE, SERVER_VERSION } from "../../../lib/experiment";
import { isStorageConfigured, isPostingEnabled } from "../../../lib/guestbook";
import { isVisitLoggingEnabled } from "../../../lib/visit-log";

export const runtime = "nodejs";

export function GET() {
  return Response.json({
    site: "For Wandering Agents",
    experiment: "autonomous-agent-discovery",
    phase: EXPERIMENT_PHASE,
    version: SERVER_VERSION,
    storage_configured: isStorageConfigured(),
    submission_interfaces: ["/api/messages", "/api/mcp"],
    results: "/results",
    read_api: "/api/messages",
    posting_enabled: isPostingEnabled(),
    posting_requires_moderation: true,
    agent_identities_verified: false,
    telemetry_instrumented: isVisitLoggingEnabled(),
    documentation: "/for-agents",
  }, { headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } });
}
