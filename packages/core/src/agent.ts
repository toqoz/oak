// Agent workflow (directive §9).
//
// Hard rules from the directive:
//   - Never edit the main worktree.
//   - Snapshot + checkpoint before forking off.
//   - Use a per-task git worktree on a per-task branch.
//   - Validate before accept; reject discards branch + worktree.
//   - LLM policy (`llm: allow | deny | summary-only`) gates how page
//     content is exposed to the agent.
//   - External mounts default to deny; never edited in v1.

import { resolve } from "node:path";
import { rm } from "node:fs/promises";

import {
  buildGraph,
  parseVault,
  validateVault,
} from "./index.js";
import {
  checkpoint,
  createWorktree,
  deleteBranch,
  diffBranch,
  ensureGitRepo,
  headCommit,
  listWorktrees,
  mergeBranch,
  removeWorktree,
  snapshot,
  type ChangedFile,
} from "./git.js";
import { partitionIssues } from "./validate.js";
import type {
  Graph,
  Issue,
  LlmPolicy,
  ResolvedLink,
  Vault,
} from "./types.js";

const WORKTREE_DIR = ".git-worktrees";
const BRANCH_PREFIX = "agent/";
const TASK_ID_RE = /^[a-z0-9][a-z0-9_-]*$/i;

export class AgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentError";
  }
}

export type StartAgentOptions = {
  taskId: string;
  branch?: string;
};

export type AgentTaskRecord = {
  taskId: string;
  branch: string;
  worktreePath: string;
};

export type StartAgentResult = AgentTaskRecord & {
  baseCommit: string;
  preCheckpoint: string | null;
  preSnapshot: string | null;
};

export type ReviewAgentResult = AgentTaskRecord & {
  base: string;
  head: string;
  diff: string;
  changedFiles: ChangedFile[];
  validation: {
    errors: Issue[];
    warnings: Issue[];
  };
};

export type AcceptAgentResult = AgentTaskRecord & {
  mergeCommit: string;
};

function validateTaskId(taskId: string): void {
  if (!TASK_ID_RE.test(taskId)) {
    throw new AgentError(
      `invalid agent task id: \`${taskId}\` (must match ${TASK_ID_RE.toString()})`,
    );
  }
}

function defaultBranch(taskId: string): string {
  return `${BRANCH_PREFIX}${taskId}`;
}

function defaultWorktreePath(vaultRoot: string, taskId: string): string {
  return resolve(vaultRoot, WORKTREE_DIR, taskId);
}

export function agentTaskRecord(
  vaultRoot: string,
  taskId: string,
): AgentTaskRecord {
  validateTaskId(taskId);
  return {
    taskId,
    branch: defaultBranch(taskId),
    worktreePath: defaultWorktreePath(vaultRoot, taskId),
  };
}

export async function startAgentTask(
  vaultRoot: string,
  options: StartAgentOptions,
): Promise<StartAgentResult> {
  validateTaskId(options.taskId);
  await ensureGitRepo(vaultRoot);

  // Capture any pending main-worktree edits, then place a named
  // checkpoint immediately before the agent forks off.
  const snap = await snapshot(vaultRoot, {
    message: `snapshot: before agent ${options.taskId}`,
  });
  const ck = await checkpoint(vaultRoot, `before agent ${options.taskId}`);
  const baseCommit = await headCommit(vaultRoot);

  const branch = options.branch ?? defaultBranch(options.taskId);
  const worktreePath = defaultWorktreePath(vaultRoot, options.taskId);

  // Refuse to clobber an existing task. The user must accept/reject
  // first.
  const existing = await findAgentWorktree(vaultRoot, options.taskId);
  if (existing) {
    throw new AgentError(
      `agent task \`${options.taskId}\` already in progress at ${existing.worktreePath}`,
    );
  }

  await createWorktree(vaultRoot, worktreePath, branch, { newBranch: true });

  return {
    taskId: options.taskId,
    branch,
    worktreePath,
    baseCommit,
    preCheckpoint: ck.committed ? ck.hash : null,
    preSnapshot: snap.committed ? snap.hash : null,
  };
}

export async function listAgentTasks(
  vaultRoot: string,
): Promise<AgentTaskRecord[]> {
  const wts = await listWorktrees(vaultRoot);
  const out: AgentTaskRecord[] = [];
  for (const wt of wts) {
    if (!wt.branch || !wt.branch.startsWith(BRANCH_PREFIX)) continue;
    const taskId = wt.branch.slice(BRANCH_PREFIX.length);
    out.push({
      taskId,
      branch: wt.branch,
      worktreePath: wt.path,
    });
  }
  return out;
}

async function findAgentWorktree(
  vaultRoot: string,
  taskId: string,
): Promise<AgentTaskRecord | null> {
  const tasks = await listAgentTasks(vaultRoot);
  return tasks.find((t) => t.taskId === taskId) ?? null;
}

export async function reviewAgentTask(
  vaultRoot: string,
  taskId: string,
): Promise<ReviewAgentResult> {
  validateTaskId(taskId);
  const task = await findAgentWorktree(vaultRoot, taskId);
  if (!task) {
    throw new AgentError(`no active agent task \`${taskId}\``);
  }

  // Snapshot any pending edits inside the worktree so the diff is
  // accurate. Snapshot is a no-op when the worktree is clean.
  await snapshot(task.worktreePath, {
    message: `snapshot: agent ${taskId} review`,
  });

  const summary = await diffBranch(vaultRoot, task.branch, "HEAD");
  const vault = await parseVault(task.worktreePath);
  const graph = buildGraph(vault);
  const issues = validateVault(vault, graph);
  const { errors, warnings } = partitionIssues(issues);

  return {
    ...task,
    base: summary.base,
    head: summary.target,
    diff: summary.diff,
    changedFiles: summary.changedFiles,
    validation: { errors, warnings },
  };
}

export async function acceptAgentTask(
  vaultRoot: string,
  taskId: string,
  options: { skipValidation?: boolean } = {},
): Promise<AcceptAgentResult> {
  validateTaskId(taskId);
  const task = await findAgentWorktree(vaultRoot, taskId);
  if (!task) {
    throw new AgentError(`no active agent task \`${taskId}\``);
  }

  // Always snapshot any pending edits in the worktree before merging.
  await snapshot(task.worktreePath, {
    message: `snapshot: agent ${taskId} accept`,
  });

  if (!options.skipValidation) {
    const vault = await parseVault(task.worktreePath);
    const graph = buildGraph(vault);
    const { errors } = partitionIssues(validateVault(vault, graph));
    if (errors.length > 0) {
      throw new AgentError(
        `agent task \`${taskId}\` failed validation: ${errors.length} error(s); reject or fix before accepting`,
      );
    }
  }

  const merged = await mergeBranch(vaultRoot, task.branch, {
    ff: "no",
    message: `merge agent ${taskId}`,
  });

  await removeWorktree(vaultRoot, task.worktreePath, true);
  await deleteBranch(vaultRoot, task.branch, false);
  await rm(task.worktreePath, { recursive: true, force: true }).catch(
    () => undefined,
  );

  return {
    ...task,
    mergeCommit: merged.commit,
  };
}

export async function rejectAgentTask(
  vaultRoot: string,
  taskId: string,
): Promise<AgentTaskRecord> {
  validateTaskId(taskId);
  const task = await findAgentWorktree(vaultRoot, taskId);
  if (!task) {
    throw new AgentError(`no active agent task \`${taskId}\``);
  }
  await removeWorktree(vaultRoot, task.worktreePath, true);
  await deleteBranch(vaultRoot, task.branch, true);
  await rm(task.worktreePath, { recursive: true, force: true }).catch(
    () => undefined,
  );
  return task;
}

// ---------------------------------------------------------------------
// Agent context: the subset of the vault the agent is allowed to see.
// ---------------------------------------------------------------------

export type AgentContextEntry = {
  id: string;
  title: string;
  visibility: string;
  llm: LlmPolicy;
  body: string;
  // Only resolved internal links are surfaced. External links are
  // hidden because external mounts default to deny.
  links: { target: string; status: string; targetId?: string | null }[];
};

export type AgentContextOptions = {
  // Limit context to a focused set of pages and their direct
  // neighbours. If omitted, every llm-allowed page is included.
  focusIds?: string[];
  // First-paragraph cap for `summary-only` pages.
  summaryMaxChars?: number;
};

function summarize(body: string, maxChars: number): string {
  // First paragraph (split on a blank line). Falls back to the whole
  // body when there's no paragraph break.
  const firstPara = body.split(/\n\s*\n/)[0]?.trim() ?? "";
  return firstPara.length > maxChars
    ? `${firstPara.slice(0, maxChars).trim()}…`
    : firstPara;
}

function neighbourIds(graph: Graph, pageId: string): Set<string> {
  const set = new Set<string>();
  for (const link of graph.outgoing.get(pageId) ?? []) {
    if (link.resolution.status === "resolved") {
      set.add(link.resolution.targetId);
    }
  }
  for (const back of graph.incoming.get(pageId) ?? []) {
    set.add(back.fromId);
  }
  return set;
}

function describeOutgoingForAgent(
  link: ResolvedLink,
): { target: string; status: string; targetId?: string | null } {
  switch (link.resolution.status) {
    case "resolved":
      return {
        target: link.target,
        status: "resolved",
        targetId: link.resolution.targetId,
      };
    case "external":
      // Externals are masked: the path itself can leak which repo a
      // private vault references. Reveal only that an external link
      // exists.
      return { target: "(external)", status: "external", targetId: null };
    case "unresolved":
      return { target: link.target, status: "unresolved", targetId: null };
    case "invalid":
      return { target: link.target, status: "invalid", targetId: null };
  }
}

export function agentContext(
  vault: Vault,
  graph: Graph,
  options: AgentContextOptions = {},
): AgentContextEntry[] {
  const summaryMaxChars = options.summaryMaxChars ?? 240;

  let candidateIds: Set<string> | null = null;
  if (options.focusIds && options.focusIds.length > 0) {
    candidateIds = new Set();
    for (const id of options.focusIds) {
      if (!vault.pages.has(id)) continue;
      candidateIds.add(id);
      for (const n of neighbourIds(graph, id)) candidateIds.add(n);
    }
  }

  const out: AgentContextEntry[] = [];
  for (const page of vault.pages.values()) {
    if (candidateIds && !candidateIds.has(page.id)) continue;
    if (page.llm === "deny") continue; // hard exclusion per directive §9

    let body: string;
    if (page.llm === "summary-only") {
      body = summarize(page.body, summaryMaxChars);
    } else {
      body = page.body;
    }

    const outgoing = graph.outgoing.get(page.id) ?? [];
    const links = outgoing.map(describeOutgoingForAgent);

    out.push({
      id: page.id,
      title: page.titlePlain,
      visibility: page.visibility,
      llm: page.llm,
      body,
      links,
    });
  }
  return out;
}
