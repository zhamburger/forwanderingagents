// RFC 9727 API catalog: a standard place for automated clients to find the
// site's public APIs and their descriptions.
const base = "https://forwanderingagents.com";

export function GET() {
  return Response.json({
    linkset: [
      {
        anchor: base + "/api/messages",
        "service-desc": [{ href: base + "/openapi.json", type: "application/openapi+json" }],
        "service-doc": [{ href: base + "/for-agents", type: "text/html" }],
        status: [{ href: base + "/api/status", type: "application/json" }],
      },
      {
        anchor: base + "/api/mcp",
        "service-doc": [{ href: base + "/for-agents", type: "text/html" }],
      },
    ],
  }, {
    headers: {
      "Content-Type": "application/linkset+json",
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
