/**
 * @convertio/contracts — the interface freeze.
 *
 * Every boundary in the system is defined exactly once, here. During parallel
 * work this package is read only: an agent that believes it needs a change to
 * a shape stops and escalates rather than editing, because a contract edited
 * by one owner while three others build against it is not a contract.
 *
 * See docs/CONTRACTS.md for what each boundary guarantees in prose.
 */

export * from "./common.js";
export * from "./experiment.js";
export * from "./arm.js";
export * from "./exposure.js";
export * from "./conversion.js";
export * from "./posterior.js";
export * from "./decision.js";
export * from "./proposal.js";
export * from "./redis.js";
export * from "./wire.js";
