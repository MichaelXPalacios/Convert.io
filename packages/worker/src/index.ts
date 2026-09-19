/**
 * @convertio/worker — the posterior recompute.
 *
 * The worker writes what the edge reads: it turns exposures and conversions
 * into Beta posteriors, stores them, and produces the mirror the request path
 * loads in one round trip. It is a library rather than a process so that the
 * cron route, a backfill and a test can all drive the same code.
 */

export {
  allocate,
  recomputeAll,
  type ArmPosterior,
  type ExperimentRecompute,
  type QueryFn,
  type QueryResultLike,
  type RecomputeDeps,
} from "./recompute.js";
