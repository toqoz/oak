// Refile feature surface.
//
// Refile is a generic heading-manipulation feature, separated from the
// agenda module so its config (`.oak/refile.yml`) and docs live in
// their own home. The agenda parser is still used internally to
// resolve entry-id sources — that's the entire interaction surface.

export {
  collectRefileTargets,
  findEnclosingHeading,
  findHeadingsInRange,
  refile,
  RefileError,
} from "./refile.js";
export type {
  RefileLocation,
  RefileResult,
  RefileSource,
  RefileTarget,
} from "./refile.js";

export {
  DEFAULT_REFILE_CONFIG,
  loadRefileConfig,
  mergeRefileConfig,
} from "./config.js";
export type { RefileConfig } from "./config.js";
