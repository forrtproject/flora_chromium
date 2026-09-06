import { z } from "zod";
import type { DoiString, ReplicationResult } from "./types";
import { ReplicationResultSchema } from "./types";
import { debugLog, debugError } from "./debug";

// Loose envelope — validate each result individually below so one malformed
// entry can't fail the whole batch.
const ResponseEnvelopeSchema = z.object({
  results: z.record(z.string(), z.unknown()),
});

const SetSchema = z.object({
  id: z.string().min(1),
});

const API_BASE = "https://rep-api.forrt.org";
const BATCH_SIZE = 50;

/**
 * Look up replication data for a batch of DOIs.
 * Uses the FORRT replication API: GET /v1/original-lookup?dois=doi1,doi2,...
 * Splits into batches of 50 to limit URL length.
 * Populates `errors` for failed DOIs while retaining successful batch results.
 */
export async function lookupDOIs(
  dois: DoiString[],
  errors: Record<string, string> = {},
): Promise<Map<DoiString, ReplicationResult>> {
  if (dois.length === 0) {
    return new Map();
  }

  const results = new Map<DoiString, ReplicationResult>();
  const totalBatches = Math.ceil(dois.length / BATCH_SIZE);
  debugLog(`Looking up ${dois.length} DOIs in ${totalBatches} batch(es) of ${BATCH_SIZE}`);

  for (let i = 0; i < dois.length; i += BATCH_SIZE) {
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const batch = dois.slice(i, i + BATCH_SIZE);
    debugLog(`Batch ${batchNum}/${totalBatches}: ${batch.length} DOIs`);
    try {
      const batchResults = await lookupBatch(batch, errors);
      for (const [doi, result] of batchResults) {
        results.set(doi, result);
      }
      debugLog(`Batch ${batchNum} returned ${batchResults.size} results`);
    } catch (err) {
      debugError(`Batch ${batchNum} failed:`, err);
      const message = err instanceof Error ? err.message : "Lookup failed";
      for (const doi of batch) errors[doi] = message;
    }
  }

  debugLog(`Total results across all batches: ${results.size}`);
  return results;
}

export async function createDoiSet(dois: DoiString[]): Promise<string | null> {
  if (dois.length === 0) return null;

  try {
    const response = await fetch(`${API_BASE}/v1/sets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dois }),
    });

    if (!response.ok) {
      throw new Error(`FLoRA API error: ${response.status}`);
    }

    const { id } = SetSchema.parse(await response.json());
    debugLog(`Created DOI set ${id} for ${dois.length} DOIs`);
    return id;
  } catch (err) {
    debugError(`Could not create a DOI set for ${dois.length} DOIs:`, err);
    return null;
  }
}

async function lookupBatch(
  dois: DoiString[],
  errors: Record<string, string> = {},
): Promise<Map<DoiString, ReplicationResult>> {
  const doisParam = dois.join(",");
  const response = await fetch(
    `${API_BASE}/v1/original-lookup?dois=${encodeURIComponent(doisParam)}`
  );

  if (!response.ok) {
    throw new Error(`FLoRA API error: ${response.status}`);
  }

  const raw = await response.json();
  const envelope = ResponseEnvelopeSchema.parse(raw);

  const results = new Map<DoiString, ReplicationResult>();
  for (const [doi, rawResult] of Object.entries(envelope.results)) {
    if (rawResult == null) continue; // genuine no-record for this DOI
    const parsed = ReplicationResultSchema.safeParse(rawResult);
    if (parsed.success) {
      results.set(doi.toLowerCase() as DoiString, parsed.data);
    } else {
      errors[doi.toLowerCase()] = "FLoRA API returned a malformed result";
      // Skip a malformed entry rather than failing every DOI in the batch.
      debugError(`FLoRA API: skipping malformed result for ${doi}:`, parsed.error.issues);
    }
  }

  return results;
}
