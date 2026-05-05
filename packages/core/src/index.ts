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
export {
  extractAssetRefs,
  isAssetTarget,
  pageEmbedRefs,
  ASSET_EXTENSIONS,
} from "./assets.js";
export type { AssetRef } from "./assets.js";
export { renderPage, renderPageDocument, rewriteBody } from "./render.js";
export type { RenderContext } from "./render.js";
export {
  ensureGitRepo,
  ensureGitignore,
  isGitRepo,
  gitStatus,
  snapshot,
  checkpoint,
  recentCommits,
  headCommit,
  listWorktrees,
  createWorktree,
  removeWorktree,
  deleteBranch,
  diffBranch,
  mergeBranch,
  GitError,
} from "./git.js";
export type {
  GitStatus,
  GitStatusEntry,
  CommitRecord,
  SnapshotResult,
  EnsureRepoResult,
  WorktreeRecord,
  ChangedFile,
  DiffSummary,
} from "./git.js";
export { publish, PublishError } from "./publish.js";
export type {
  PublishOptions,
  PublishStats,
  PublishedPage,
  PublishedAsset,
  PublishManifest,
} from "./publish.js";
