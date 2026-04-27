/**
 * bridge-wire.ts — extension-side view of the bridge HTTP contract.
 *
 * The canonical definitions live in apps/server/src/contracts/. This file
 * re-exports them under a single name the extension code imports from,
 * so the extension never has to dig into the server tree.
 *
 * In Phase 2 the build system copies apps/server/src/contracts/*.ts into
 * the extension's contracts dir at build time. Until then, a single
 * relative path reaches across the repo. Either way, there is exactly
 * one source of truth for the wire format.
 *
 * CONTRACTS ONLY. No runtime.
 */

// Relative path is intentional for Phase 1. Phase 2 build will replace
// this with a copied-in local path.
export * from "../../../server/src/contracts/envelope.js";
export * from "../../../server/src/contracts/jobs.js";
export * from "../../../server/src/contracts/api.js";
export * from "../../../server/src/contracts/newgrad.js";
export * from "../../../server/src/contracts/autofill.js";
