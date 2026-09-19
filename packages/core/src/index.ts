/**
 * @convertio/core — the logic both runtimes share.
 *
 * Everything here is pure, dependency-injected and framework-free: no JSX, no
 * Next import, no ambient environment read. That is what lets the same code be
 * tested without a server, run on the edge runtime, and be called by the Node
 * worker.
 *
 * The sharing is not incidental. The worker writes the posterior mirror and the
 * edge reads it; if each implemented the format independently they would
 * eventually disagree about a field, the edge would read stale nonsense, and
 * nothing would error. `serializePosteriorMirror` in @convertio/contracts and
 * `MirrorStore` here are the two halves of that contract.
 */

export * from "./bandit.js";
export * from "./assign.js";
export * from "./mirror.js";
export * from "./identity.js";
export * from "./select.js";
