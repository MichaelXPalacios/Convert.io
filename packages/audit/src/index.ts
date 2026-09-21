/**
 * @convertio/audit — the engine that reads a landing page and proposes
 * variants worth testing.
 *
 * Two halves, deliberately separable. `extractFacts` is deterministic: it
 * parses HTML and runs checks that are either true or false about the page.
 * `analyze` is not: it sends those facts to a model and asks what is costing
 * conversions. Only the second half can be wrong in interesting ways, and
 * keeping it behind its own call is what lets the first half be tested.
 */

export { extractFacts, type PageFacts, type Signal } from "./heuristics.js";
export { analyze, type Analysis, type Finding } from "./analyze.js";
export { feedbackReport, implementationPlan, outreachEmail } from "./report.js";
export {
  assertFetchableUrl,
  fetchPage,
  isPrivateAddress,
  UrlPolicyError,
  MAX_BYTES,
  MAX_REDIRECTS,
  FETCH_TIMEOUT_MS,
  type FetchedPage,
} from "./url-policy.js";
