// Ownership proof for the Glama MCP directory. The claim token comes from
// Glama's "Claim ownership" dialog and is public by design; it lives in an
// environment variable so it can be set without a code change.
export function GET() {
  const claim = process.env.GLAMA_CLAIM_TOKEN?.trim();
  if (!claim) return new Response("Not found", { status: 404 });
  return Response.json({ $schema: "https://glama.ai/mcp/schemas/connector.json", claim }, {
    headers: { "Cache-Control": "public, max-age=300" },
  });
}
