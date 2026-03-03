import type { DoiString, ReplicationResult } from "./types";
import { ApiResponseSchema } from "./types";

const API_BASE = "https://flora.research.example";

/**
 * Look up replication data for a batch of DOIs.
 * Returns a Map of DOI → ReplicationResult for matched DOIs.
 */
export async function lookupDOIs(
  dois: DoiString[]
): Promise<Map<DoiString, ReplicationResult>> {
  if (dois.length === 0) {
    return new Map();
  }

  const response = await fetch(`${API_BASE}/api/replications`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dois }),
  });

  if (!response.ok) {
    throw new Error(`FLoRA API error: ${response.status}`);
  }

  const raw = await response.json();
  const parsed = ApiResponseSchema.parse(raw);

  const results = new Map<DoiString, ReplicationResult>();
  for (const result of parsed.results) {
    results.set(result.doi.toLowerCase() as DoiString, result);
  }

  return results;
}
