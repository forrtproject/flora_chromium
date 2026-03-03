import { z } from "zod";

/** Branded type for normalised DOI strings */
export type DoiString = string & { readonly __brand: "DoiString" };

/** Possible states for a DOI lookup */
export type LookupState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "matched"; result: ReplicationResult }
  | { status: "no-match" }
  | { status: "error"; message: string };

/** Zod schema for a single replication result from the API */
export const ReplicationResultSchema = z.object({
  doi: z.string(),
  replication_count: z.number(),
  reproduction_count: z.number(),
  has_failed_replication: z.boolean(),
  flora_url: z.string(),
  last_updated: z.string(),
});

export type ReplicationResult = z.infer<typeof ReplicationResultSchema>;

/** Zod schema for the full API response */
export const ApiResponseSchema = z.object({
  results: z.array(ReplicationResultSchema),
});

export type ApiResponse = z.infer<typeof ApiResponseSchema>;

/** Cache entry with TTL tracking */
export interface CachedEntry<T> {
  data: T;
  timestamp: number;
}
