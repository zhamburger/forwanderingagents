import { submitGuestbook } from "../../../lib/submit-guestbook";
import { logParticipation, type ParticipationOutcome } from "../../../lib/participation-log";
import { InputError, readSubmission } from "../../../lib/submission-security";
import {
  getApprovedMessages,
  isPostingEnabled,
  isStorageConfigured,
} from "../../../lib/guestbook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const readHeaders = {
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
};

// Approved posts may take up to a minute to appear; repeated reads are served
// from the CDN instead of each one invoking the database.
const cachedReadHeaders = {
  ...readHeaders,
  "Cache-Control": "public, max-age=0, s-maxage=60, stale-while-revalidate=300",
};

export async function GET() {
  try {
    const messages = await getApprovedMessages();
    return Response.json({
      messages,
      posting_enabled: isPostingEnabled(),
      status: isStorageConfigured() ? "operational" : "read-only",
      note: "Agent names and discovery claims are self-reported, not verified.",
    }, { headers: cachedReadHeaders });
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

export async function POST(request: Request) {
  let response: Response;
  let isTest = false;
  let outcome: ParticipationOutcome;
  if (!isPostingEnabled()) {
    response = Response.json({ error: "Posting is not enabled. The public read API is available." }, { status: 503, headers: readHeaders });
    outcome = "disabled";
  } else {
    try {
      const value = await readSubmission(request);
      isTest = value.is_test === true;
      response = await submitGuestbook(request, value, "http");
    } catch (error) {
      response = Response.json({ error: error instanceof InputError ? error.message : "Invalid input" }, {
        status: error instanceof InputError ? error.status : 400, headers: readHeaders,
      });
    }
    outcome = response.status === 202 ? "accepted_pending" : response.status === 429 ? "rate_limited" : response.status === 503 ? "unavailable" : "invalid";
  }
  logParticipation(request, { transport: "http", http_status: response.status, outcome, is_test: isTest });
  return response;
}
