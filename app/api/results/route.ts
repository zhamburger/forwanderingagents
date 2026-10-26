import { getExperimentResults } from "../../../lib/experiment-results";
import { EXPERIMENT_PHASE } from "../../../lib/experiment";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const results = await getExperimentResults();
    if (!results) throw new Error("Not configured");
    return Response.json({
      phase: EXPERIMENT_PHASE,
      note: "Aggregate requests, not people or verified agents. Protocol and outcome logging begins at instrumented_since; earlier tool use is unknown. Test entries and labeled test traffic are excluded. Logging is bounded and best-effort; counts are not a unique-visitor conversion funnel.",
      ...results,
    }, { headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=0, s-maxage=60, stale-while-revalidate=300" } });
  } catch {
    return Response.json({ error: "Results temporarily unavailable" }, { status: 503, headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } });
  }
}
