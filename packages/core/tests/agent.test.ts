import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  acceptAgentTask,
  agentContext,
  AgentError,
  buildGraph,
  ensureGitRepo,
  listAgentTasks,
  parseVault,
  rejectAgentTask,
  reviewAgentTask,
  snapshot,
  startAgentTask,
} from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fxRoot = (name: string) => resolve(__dirname, "fixtures", name);

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(resolve(tmpdir(), "oak-agent-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function copyFixture(name: string): Promise<string> {
  const dest = resolve(scratch, name);
  await cp(fxRoot(name), dest, { recursive: true });
  return dest;
}

describe("agentContext (LLM policy)", () => {
  it("excludes deny pages, summarises summary-only, includes allow", async () => {
    const root = resolve(scratch, "vault");
    await cp(fxRoot("basic"), root, { recursive: true });

    // Tweak the fixture: set per-page llm policies.
    const setLlm = async (file: string, llm: string) => {
      const p = resolve(root, file);
      const raw = await readFile(p, "utf8");
      const updated = raw.replace(
        /^---\n/,
        `---\nllm: ${llm}\n`,
      );
      await writeFile(p, updated, "utf8");
    };
    await setLlm("Local File First.md", "allow");
    await setLlm("Project Alpha.md", "summary-only");
    await setLlm("Diary.md", "deny");

    const vault = await parseVault(root);
    const graph = buildGraph(vault);
    const ctx = agentContext(vault, graph, { summaryMaxChars: 40 });

    const titles = ctx.map((e) => e.title).sort();
    expect(titles).toEqual(["Local File First", "Project Alpha"]);

    const lff = ctx.find((e) => e.title === "Local File First")!;
    expect(lff.llm).toBe("allow");
    expect(lff.body).toContain("vault is just a folder");

    const projectAlpha = ctx.find((e) => e.title === "Project Alpha")!;
    expect(projectAlpha.llm).toBe("summary-only");
    expect(projectAlpha.body.length).toBeLessThanOrEqual(41); // <= max + ellipsis
  });

  it("masks external link targets", async () => {
    const root = await copyFixture("external-leak");
    const vault = await parseVault(root);
    const graph = buildGraph(vault);
    // Mark the page as llm:allow so it's surfaced.
    const path = resolve(root, "Public.md");
    const raw = await readFile(path, "utf8");
    await writeFile(path, raw.replace(/^---\n/, "---\nllm: allow\n"), "utf8");
    const v2 = await parseVault(root);
    const g2 = buildGraph(v2);
    const ctx = agentContext(v2, g2);
    const entry = ctx[0]!;
    const externalLinks = entry.links.filter((l) => l.status === "external");
    expect(externalLinks.length).toBeGreaterThan(0);
    expect(externalLinks.every((l) => l.target === "(external)")).toBe(true);
    void vault;
    void graph;
  });
});

describe("agent workflow lifecycle", () => {
  async function makeRepoFixture(): Promise<string> {
    // Use a fresh, ULID-bearing page so the vault parses cleanly and
    // the worktree workflow is exercised end to end.
    const root = resolve(scratch, "vault");
    await cp(fxRoot("basic"), root, { recursive: true });
    await ensureGitRepo(root);
    await snapshot(root, { message: "snapshot: bootstrap" });
    return root;
  }

  it("start creates a branch + worktree, list shows it, reject cleans up", async () => {
    const root = await makeRepoFixture();
    const r = await startAgentTask(root, { taskId: "rename-project-alpha" });
    expect(r.branch).toBe("agent/rename-project-alpha");
    expect(r.worktreePath).toContain(".git-worktrees/rename-project-alpha");

    const list = await listAgentTasks(root);
    expect(list).toHaveLength(1);
    expect(list[0]!.taskId).toBe("rename-project-alpha");

    // Reject
    await rejectAgentTask(root, "rename-project-alpha");
    const after = await listAgentTasks(root);
    expect(after).toHaveLength(0);

    // .git-worktrees/<task> dir is gone
    const wtParent = resolve(root, ".git-worktrees");
    const entries = await readdir(wtParent).catch(() => [] as string[]);
    expect(entries).not.toContain("rename-project-alpha");
  });

  it("rejects duplicate task ids", async () => {
    const root = await makeRepoFixture();
    await startAgentTask(root, { taskId: "dup" });
    await expect(
      startAgentTask(root, { taskId: "dup" }),
    ).rejects.toBeInstanceOf(AgentError);
    await rejectAgentTask(root, "dup");
  });

  it("validates task id format", async () => {
    const root = await makeRepoFixture();
    await expect(
      startAgentTask(root, { taskId: "has spaces" }),
    ).rejects.toThrow(/invalid agent task id/);
  });

  it("review reports diff and validation; accept merges and cleans up", async () => {
    const root = await makeRepoFixture();
    const r = await startAgentTask(root, { taskId: "edit-project-alpha" });

    // Agent edits a page inside the worktree.
    const path = resolve(r.worktreePath, "Project Alpha.md");
    const original = await readFile(path, "utf8");
    await writeFile(path, original + "\n\nAgent added this line.\n", "utf8");

    const review = await reviewAgentTask(root, "edit-project-alpha");
    expect(review.changedFiles.some((c) => c.path === "Project Alpha.md")).toBe(
      true,
    );
    expect(review.diff).toContain("Agent added this line.");
    expect(review.validation.errors).toEqual([]);

    const accepted = await acceptAgentTask(root, "edit-project-alpha");
    expect(accepted.mergeCommit).toMatch(/^[0-9a-f]{40}$/);

    // Worktree gone, branch gone
    const list = await listAgentTasks(root);
    expect(list).toHaveLength(0);
    // Edit visible in main worktree
    const merged = await readFile(resolve(root, "Project Alpha.md"), "utf8");
    expect(merged).toContain("Agent added this line.");
  });

  it("accept refuses to merge a worktree that fails validation", async () => {
    const root = await makeRepoFixture();
    const r = await startAgentTask(root, { taskId: "bad-edit" });

    // Introduce a broken page (no id, no title).
    await writeFile(
      resolve(r.worktreePath, "Broken.md"),
      "no frontmatter here\n",
      "utf8",
    );

    await expect(acceptAgentTask(root, "bad-edit")).rejects.toThrow(
      /failed validation/,
    );
    // Cleanup so afterEach can remove the dir
    await rejectAgentTask(root, "bad-edit");
  });
});
