export * from "./types.js";
export { extractLinks } from "./links.js";
export { parsePage, parseVault } from "./parse.js";
export { composePage, createPage, pathSafeFilename } from "./create.js";
export { newId } from "./id.js";
export type {
  ComposedPage,
  CreatePageOptions,
  CreatePageResult,
} from "./create.js";
export { homeViewModel, excerptFrom } from "./home.js";
export type {
  HomeViewModel,
  HomeViewOptions,
  HomeEntry,
  HomeStats,
  UnmanagedEntry,
} from "./home.js";
export { searchVault, searchDocs } from "./search.js";
export type {
  SearchDoc,
  SearchHit,
  SearchSnippet,
  SearchMatchKind,
  SearchOptions,
  Range,
} from "./search.js";
export {
  buildGraph,
  resolveLinks,
  resolveTarget,
  getOutboundLinks,
  getBacklinks,
  getTwoHopLinks,
  isRedlinkTarget,
  linkTargetId,
  redlinkTargetId,
} from "./graph.js";
export { validateVault, partitionIssues } from "./validate.js";
export {
  slugify,
  normalizeKey,
  plainTextTitle,
  extractFirstH1,
} from "./slug.js";
export {
  coerceTimestamp,
  isOakManaged,
  nowIsoSecond,
  recoverCreatedTimestamp,
  setCreatedAndModified,
  setCreatedIfMissing,
  setFrontmatterVersion,
  setModified,
  setModifiedIfMissing,
  shouldBumpModified,
  withTimestampUpdate,
  withTimestampUpdateAndRecovery,
} from "./timestamps.js";
export {
  LATEST_FRONTMATTER_VERSION,
  getFrontmatterVersion,
  migrateFrontmatter,
  migratePageRaw,
  type AddedFields,
  type FrontmatterMigrationEntry,
  type FrontmatterMigrationReport,
  type MigrateFrontmatterOptions,
  type MigrationContext,
  type MigrationStep,
} from "./frontmatter-migrate.js";
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
export { processBodyAssets, resolveAssetSource } from "./asset-process.js";
export type {
  AssetWritten,
  ProcessedAssets,
} from "./asset-process.js";
export {
  ensureGitRepo,
  ensureGitignore,
  gitFirstAddedTime,
  isGitRepo,
  gitStatus,
  snapshot,
  pullRebase,
  checkpoint,
  recentCommits,
  headCommit,
  listWorktrees,
  createWorktree,
  removeWorktree,
  deleteBranch,
  diffBranch,
  mergeBranch,
  branchExists,
  createOrphanBranch,
  GitError,
} from "./git.js";
export type {
  GitStatus,
  GitStatusEntry,
  CommitRecord,
  SnapshotResult,
  PullRebaseResult,
  EnsureRepoResult,
  WorktreeRecord,
  ChangedFile,
  DiffSummary,
} from "./git.js";
export {
  startAgentTask,
  reviewAgentTask,
  acceptAgentTask,
  rejectAgentTask,
  listAgentTasks,
  agentTaskRecord,
  agentContext,
  AgentError,
} from "./agent.js";
export type {
  StartAgentOptions,
  StartAgentResult,
  AgentTaskRecord,
  ReviewAgentResult,
  AcceptAgentResult,
  AgentContextEntry,
  AgentContextOptions,
} from "./agent.js";
export {
  collectPublishablePaths,
  pubInit,
  pubBuild,
  pubStatus,
  PubError,
  DEFAULT_PUBLISH_BRANCH,
  PUBLISH_WORKTREE_REL,
} from "./publish-branch.js";
export type {
  PubInitOptions,
  PubInitResult,
  PubBuildOptions,
  PubBuildResult,
} from "./publish-branch.js";
export {
  FEED_DATES_FILENAME,
  readFeedDates,
  syncFeedDates,
  writeFeedDates,
} from "./feed-dates.js";
export type { FeedDates, SyncFeedDatesResult } from "./feed-dates.js";
export { syncPaths } from "./sync-tree.js";
export type { SyncResult } from "./sync-tree.js";
export { relatedView } from "./related.js";
export type {
  OutboundEntry,
  InboundEntry,
  PageRef,
  RelatedOptions,
  RelatedView,
  TwoHopBridgeEntry,
  TwoHopEntry,
} from "./related.js";
export {
  collectRedlinks,
  redlinkIdFor,
  redlinkSlug,
} from "./redlinks.js";
export type {
  RedlinkBridge,
  RedlinkOptions,
  RedlinkSummary,
} from "./redlinks.js";
export {
  DEFAULT_AGENDA_CONFIG,
  addUnits,
  advanceRepeater,
  buildEffectiveTags,
  buildMatchView,
  buildSearchView,
  buildTodoView,
  buildWeeklyAgenda,
  compareTimestamps,
  compileMatch,
  dateOnly,
  dayName,
  dayOfWeek,
  daysBetween,
  extractVaultAgendaEntries,
  formatTimestamp,
  frontmatterLineCount,
  isPageInAgendaScope,
  loadAgendaConfig,
  markDone,
  mergeAgendaConfig,
  nowIsoMinute,
  parseAgendaPage,
  parseAllTimestamps,
  parsePlanningLine,
  parseRangeTimestamp,
  parseTimestamp,
  runAgenda,
  startOfWeek,
  todayIso,
  withinWarning,
  WriteBackError,
} from "./agenda/index.js";
export type {
  AgendaConfig,
  AgendaEntry,
  AgendaItem,
  AgendaMarker,
  AgendaQuery,
  AgendaTimestamp,
  AgendaView,
  DurationUnit,
  MarkDoneResult,
  MatchPredicate,
  Repeater,
  RepeaterKind,
  SkipDeadlinePrewarningPolicy,
  WarningPeriod,
} from "./agenda/index.js";

export {
  collectRefileTargets,
  findEnclosingHeading,
  findHeadingsInRange,
  refile,
  RefileError,
} from "./refile/index.js";
export type {
  RefileLocation,
  RefileResult,
  RefileSource,
  RefileTarget,
} from "./refile/index.js";
