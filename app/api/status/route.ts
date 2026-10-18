import { isStorageConfigured, isPostingEnabled } from "../../../lib/guestbook";

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
    telemetry_instrumented: false,
    documentation: "/for-agents",
  }, { headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } });
}
