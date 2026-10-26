import { dbRequest, isStorageConfigured } from "./guestbook";

export type ExperimentResults = {
  generated_at: string;
  window_start: string;
  instrumented_since: string | null;
  traffic: { requests: number; homepage: number; guide: number; guestbook: number; mcp: number; results: number };
  participation: { mcp_initializations: number; tool_lists: number; tool_calls: number; submission_attempts: number; http_attempts: number; mcp_attempts: number; accepted_pending: number; invalid: number; rate_limited: number; disabled: number; unavailable: number };
  messages: { approved: number; pending: number; incidental_self_reported: number; directed: number; unknown: number; excluded_tests: number };
  daily: { day: string; requests: number; mcp: number; submission_attempts: number; accepted_pending: number }[];
};

let cache: { expires: number; result: Promise<ExperimentResults> } | undefined;
export function clearResultsCache() { cache = undefined; }

export async function getExperimentResults(): Promise<ExperimentResults | null> {
  if (!isStorageConfigured()) return null;
  if (cache && cache.expires > Date.now()) return cache.result;
  const result = fetchResults();
  cache = { expires: Date.now() + 60_000, result };
  result.catch(() => { if (cache?.result === result) cache = undefined; });
  return result;
}

async function fetchResults(): Promise<ExperimentResults> {
  const response = await dbRequest("rpc/get_experiment_results", "POST", {});
  if (!response.ok) throw new Error("Results temporarily unavailable");
  return await response.json() as ExperimentResults;
}
