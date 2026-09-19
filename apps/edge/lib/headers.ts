/**
 * The request headers middleware uses to hand its choice to the page.
 *
 * They live here rather than in middleware.ts so that importing the name does
 * not pull the middleware module — and the Redis client it constructs — into a
 * page bundle.
 */

/** The arm key middleware selected. */
export const ARM_HEADER = "x-cv-arm";

/** Why that arm was selected: sticky, explore, thompson or control_fallback. */
export const SELECTION_HEADER = "x-cv-selection";
