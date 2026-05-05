export * from "./types.js";
export { extractLinks } from "./links.js";
export { parsePage, parseVault } from "./parse.js";
export {
  buildGraph,
  resolveLinks,
  getOutboundLinks,
  getBacklinks,
  getTwoHopLinks,
} from "./graph.js";
export { validateVault, partitionIssues } from "./validate.js";
export { slugify, normalizeKey } from "./slug.js";
export {
  writeIndex,
  readIndexMeta,
  queryIndex,
  indexPathFor,
  INDEX_SCHEMA_VERSION,
  INDEX_REL_PATH,
} from "./index-store.js";
export type { IndexStats, ReadIndexMeta } from "./index-store.js";
export {
  loadMountConfig,
  saveMountConfig,
  addMount,
  describeMount,
  listMountStatus,
  mountDoctor,
} from "./mount.js";
export type {
  MountConfig,
  MountConfigEntry,
  MountStatus,
  AddMountOptions,
} from "./mount.js";
