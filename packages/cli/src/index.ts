#!/usr/bin/env node
// Entry point for the `oak` CLI.

// Silence the one-off "SQLite is an experimental feature" warning that
// node:sqlite emits on first use. The CLI relies on it intentionally.
{
  const origEmit = process.emit.bind(process);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process as any).emit = function (event: string, ...args: unknown[]) {
    if (event === "warning") {
      const w = args[0] as { name?: string; message?: string } | undefined;
      if (
        w?.name === "ExperimentalWarning" &&
        typeof w.message === "string" &&
        /SQLite/i.test(w.message)
      ) {
        return false;
      }
    }
    return origEmit(event as never, ...(args as never[]));
  };
}

import { resolve, dirname } from "node:path";
import { mkdir, writeFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  acceptAgentTask,
  addMount,
  agentContext,
  AgentError,
  buildGraph,
  checkpoint,
  createPage,
  DEFAULT_PUBLISH_BRANCH,
  ensureGitRepo,
  extractVaultAgendaEntries,
  getBacklinks,
  getTwoHopLinks,
  gitStatus,
  listAgentTasks,
  listMountStatus,
  loadAgendaConfig,
  markDone,
  migrateTimestamps,
  mountDoctor,
  parseVault,
  partitionIssues,
  pubBuild,
  PubError,
  pubInit,
  pubStatus,
  recentCommits,
  rejectAgentTask,
  reviewAgentTask,
  runAgenda,
  snapshot,
  startAgentTask,
  startOfWeek,
  todayIso,
  validateVault,
  writeIndex,
  WriteBackError,
  type AgendaItem,
  type AgendaQuery,
  type AgendaView,
  type Visibility,
} from "@oak/core";

import { getBool, getString, parseArgs } from "./args.js";
import { lookupPage } from "./lookup.js";

const HELP = `oak — local-file-first knowledge graph (v1, phase 1)

Usage:
  oak <command> [options]

Commands:
  init                       Initialize a vault in the current directory
  new <title> [...]          Create a new page with well-formed frontmatter
  index                      Parse the vault and write .oak/index.sqlite
  validate                   Run vault validation; exits non-zero on errors
  status                     Show pending vault changes (stub in v1)
  backlinks <page>           List incoming links for a page
  twohop <page>              List two-hop neighbours for a page
  pub                        Publish branch tooling (init / build)
  snapshot [--message M]     Stage tracked files and commit a snapshot
  checkpoint <message>       Create a named commit (e.g. before publish)
  log [--n N]                Show recent oak commits
  mount add <id> <path>      Mount an external directory at _external/<id>
  mount list                 Show configured mounts and their health
  mount doctor               Report broken / overlapping mounts

  agent start <task>         Snapshot, checkpoint, and create a worktree
  agent list                 Show active agent tasks
  agent diff <task>          Show diff + validation for an agent task
  agent accept <task>        Merge the agent worktree into main, clean up
  agent reject <task>        Discard the agent worktree and branch
  agent context [--focus ID] Vault snapshot scoped by focus IDs (JSON)

  agenda                     Weekly agenda starting today (default)
  agenda a [--from D] [--days N]  Daily/weekly agenda view
  agenda t [--keyword K] [--all]  Global TODO list
  agenda m <expr>            Match by tags/properties (e.g. work+urgent-someday)
  agenda s <regex>           Search entry titles + bodies
  agenda done <path>:<line>  Mark an entry DONE; advances repeaters

  migrate timestamps         Backfill missing created/modified on oak pages
                             (use --dry-run to preview)

Common options:
  --vault <path>             Vault root (default: current directory)
  --json                     Emit JSON instead of human-readable text
  -h, --help                 Show this help

Examples:
  oak index --vault ./my-vault
  oak validate --json
  oak backlinks "Local File First"
  oak twohop "Local File First"
`;

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (
    parsed.command === undefined ||
    parsed.command === "help" ||
    getBool(parsed.flags, "help") ||
    parsed.flags["h"] === true
  ) {
    process.stdout.write(HELP);
    return parsed.command === undefined ? 1 : 0;
  }

  const vaultPath = resolve(getString(parsed.flags, "vault") ?? process.cwd());
  const json = getBool(parsed.flags, "json");

  switch (parsed.command) {
    case "init":
      return await cmdInit(vaultPath);
    case "new":
      return await cmdNew(vaultPath, parsed.positional, parsed.flags, json);
    case "index":
      return await cmdIndex(vaultPath, json);
    case "validate":
      return await cmdValidate(vaultPath, json);
    case "status":
      return await cmdStatus(vaultPath, json);
    case "backlinks":
      return await cmdBacklinks(vaultPath, parsed.positional, json);
    case "twohop":
      return await cmdTwoHop(vaultPath, parsed.positional, json);
    case "mount":
      return await cmdMount(vaultPath, parsed.positional, parsed.flags, json);
    case "agent":
      return await cmdAgent(vaultPath, parsed.positional, parsed.flags, json);
    case "pub":
      return await cmdPub(vaultPath, parsed.positional, parsed.flags, json);
    case "snapshot":
      return await cmdSnapshot(vaultPath, parsed.flags, json);
    case "checkpoint":
      return await cmdCheckpoint(vaultPath, parsed.positional, json);
    case "log":
      return await cmdLog(vaultPath, parsed.flags, json);
    case "agenda":
      return await cmdAgenda(vaultPath, parsed.positional, parsed.flags, json);
    case "migrate":
      return await cmdMigrate(vaultPath, parsed.positional, parsed.flags, json);
    default:
      process.stderr.write(`Unknown command: ${parsed.command}\n\n`);
      process.stdout.write(HELP);
      return 1;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function cmdInit(vaultPath: string): Promise<number> {
  const oakDir = resolve(vaultPath, ".oak");
  await mkdir(oakDir, { recursive: true });
  const cfgPath = resolve(oakDir, "config.yml");
  if (!(await exists(cfgPath))) {
    await writeFile(cfgPath, "version: 1\n", "utf8");
  }
  const mountsPath = resolve(oakDir, "mounts.local.yml");
  if (!(await exists(mountsPath))) {
    await writeFile(mountsPath, "mounts: {}\n", "utf8");
  }
  const repo = await ensureGitRepo(vaultPath);
  process.stdout.write(`Initialized oak vault at ${vaultPath}\n`);
  if (repo.initialized) {
    process.stdout.write(`  git: initialized fresh repo\n`);
  } else {
    process.stdout.write(`  git: existing repo detected\n`);
  }
  if (repo.gitignoreUpdated) {
    process.stdout.write(`  git: .gitignore updated\n`);
  }
  return 0;
}

function parseVisibilityFlag(s: string | undefined): Visibility | undefined {
  if (s === undefined) return undefined;
  if (s === "public" || s === "unlisted" || s === "private") return s;
  throw new Error(
    `--visibility must be one of public, unlisted, private (got \`${s}\`)`,
  );
}

async function cmdNew(
  vaultPath: string,
  positional: string[],
  flags: Record<string, string | boolean>,
  json: boolean,
): Promise<number> {
  // Title can be passed as either a single argument ("My Page") or
  // multiple bare words; we re-join so `oak new my page` works.
  const title = positional.join(" ").trim();
  if (!title) {
    process.stderr.write(
      "Usage: oak new <title> [--visibility V] [--slug S] [--alias A,B] [--at PATH]\n",
    );
    return 1;
  }
  let visibility: Visibility | undefined;
  try {
    visibility = parseVisibilityFlag(getString(flags, "visibility"));
  } catch (err) {
    process.stderr.write(`oak new: ${(err as Error).message}\n`);
    return 1;
  }
  const slug = getString(flags, "slug");
  const at = getString(flags, "at");
  const aliasesRaw = getString(flags, "alias") ?? getString(flags, "aliases");
  const aliases = aliasesRaw
    ? aliasesRaw.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
    : [];

  try {
    const result = await createPage(vaultPath, {
      title,
      ...(visibility ? { visibility } : {}),
      ...(slug ? { slug } : {}),
      ...(at ? { at } : {}),
      aliases,
    });
    if (json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      return 0;
    }
    process.stdout.write(`Created ${result.vaultRelPath}\n`);
    process.stdout.write(`  id:         ${result.id}\n`);
    process.stdout.write(`  title:      ${result.title}\n`);
    process.stdout.write(`  visibility: ${result.visibility}\n`);
    process.stdout.write(`  slug:       ${result.slug}\n`);
    if (result.aliases.length > 0) {
      process.stdout.write(`  aliases:    ${result.aliases.join(", ")}\n`);
    }
    return 0;
  } catch (err) {
    process.stderr.write(`oak new: ${(err as Error).message}\n`);
    return 1;
  }
}

async function cmdIndex(vaultPath: string, json: boolean): Promise<number> {
  const vault = await parseVault(vaultPath);
  const graph = buildGraph(vault);
  const issues = validateVault(vault, graph);
  const stats = await writeIndex(vault, graph, issues);

  if (json) {
    process.stdout.write(JSON.stringify(stats, null, 2) + "\n");
    return 0;
  }
  process.stdout.write(`Indexed ${vault.rootPath}\n`);
  process.stdout.write(`  -> ${stats.dbPath}\n`);
  process.stdout.write(`  pages:     ${stats.pages}\n`);
  process.stdout.write(`  aliases:   ${stats.aliases}\n`);
  process.stdout.write(`  links:     ${stats.links}\n`);
  process.stdout.write(`  externals: ${stats.externals}\n`);
  process.stdout.write(`  mounts:    ${stats.mounts}\n`);
  process.stdout.write(`  issues:    ${stats.issues}\n`);
  return 0;
}

async function cmdValidate(vaultPath: string, json: boolean): Promise<number> {
  const vault = await parseVault(vaultPath);
  const graph = buildGraph(vault);
  const issues = validateVault(vault, graph);
  const { errors, warnings } = partitionIssues(issues);

  if (json) {
    process.stdout.write(
      JSON.stringify({ errors, warnings }, null, 2) + "\n",
    );
  } else {
    for (const i of issues) {
      const where = i.filePath ? ` (${i.filePath})` : "";
      process.stdout.write(`${i.severity}: [${i.code}] ${i.message}${where}\n`);
    }
    process.stdout.write(
      `\n${errors.length} error(s), ${warnings.length} warning(s)\n`,
    );
  }
  return errors.length > 0 ? 1 : 0;
}

async function cmdStatus(vaultPath: string, json: boolean): Promise<number> {
  const vault = await parseVault(vaultPath);
  const graph = buildGraph(vault);
  const { errors, warnings } = partitionIssues(validateVault(vault, graph));
  const git = await gitStatus(vaultPath);
  const recent = await recentCommits(vaultPath, 3);

  if (json) {
    process.stdout.write(
      JSON.stringify(
        {
          root: vault.rootPath,
          pages: vault.pages.size,
          errors: errors.length,
          warnings: warnings.length,
          git: {
            initialized: git.initialized,
            branch: git.branch,
            dirty: git.dirty,
            staged: git.staged.length,
            unstaged: git.unstaged.length,
            untracked: git.untracked.length,
          },
          recent,
        },
        null,
        2,
      ) + "\n",
    );
    return 0;
  }
  process.stdout.write(`Vault: ${vault.rootPath}\n`);
  process.stdout.write(`  pages:    ${vault.pages.size}\n`);
  process.stdout.write(`  errors:   ${errors.length}\n`);
  process.stdout.write(`  warnings: ${warnings.length}\n`);
  if (git.initialized) {
    process.stdout.write(
      `  git:      ${git.branch ?? "(detached)"}; ` +
        `${git.dirty ? "dirty" : "clean"} ` +
        `(staged ${git.staged.length}, unstaged ${git.unstaged.length}, untracked ${git.untracked.length})\n`,
    );
    if (recent.length > 0) {
      process.stdout.write(`  recent:\n`);
      for (const c of recent) {
        process.stdout.write(`    ${c.shortHash} ${c.subject}\n`);
      }
    }
  } else {
    process.stdout.write(`  git:      (no repo — run \`oak init\`)\n`);
  }
  return 0;
}

function requirePage(
  vault: Awaited<ReturnType<typeof parseVault>>,
  positional: string[],
): { ok: true; pageId: string } | { ok: false; code: number } {
  const query = positional[0];
  if (!query) {
    process.stderr.write("Missing required <page> argument.\n");
    return { ok: false, code: 1 };
  }
  const lookup = lookupPage(vault, query);
  if (lookup.status !== "found") {
    process.stderr.write(`Page not found: ${query}\n`);
    return { ok: false, code: 1 };
  }
  return { ok: true, pageId: lookup.pageId };
}

async function cmdBacklinks(
  vaultPath: string,
  positional: string[],
  json: boolean,
): Promise<number> {
  const vault = await parseVault(vaultPath);
  const r = requirePage(vault, positional);
  if (!r.ok) return r.code;
  const graph = buildGraph(vault);
  const back = getBacklinks(graph, r.pageId);

  if (json) {
    const items = back.map((b) => {
      const fromPage = vault.pages.get(b.fromId);
      return {
        fromId: b.fromId,
        fromTitle: fromPage?.title ?? null,
        fromPath: fromPage?.relPath ?? null,
        context: b.context,
      };
    });
    process.stdout.write(JSON.stringify(items, null, 2) + "\n");
    return 0;
  }

  if (back.length === 0) {
    process.stdout.write("(no backlinks)\n");
    return 0;
  }
  for (const b of back) {
    const fromPage = vault.pages.get(b.fromId);
    const label = fromPage ? `${fromPage.title}` : b.fromId;
    process.stdout.write(`- ${label}\n    ${b.context}\n`);
  }
  return 0;
}

async function cmdTwoHop(
  vaultPath: string,
  positional: string[],
  json: boolean,
): Promise<number> {
  const vault = await parseVault(vaultPath);
  const r = requirePage(vault, positional);
  if (!r.ok) return r.code;
  const graph = buildGraph(vault);
  const hops = getTwoHopLinks(graph, r.pageId);

  if (json) {
    const items = hops.map((h) => {
      const target = vault.pages.get(h.pageId);
      return {
        pageId: h.pageId,
        title: target?.title ?? null,
        via: h.via.map((b) =>
          b.kind === "page"
            ? {
                kind: "page" as const,
                id: b.pageId,
                title: vault.pages.get(b.pageId)?.title ?? null,
              }
            : {
                kind: "redlink" as const,
                targetKey: b.targetKey,
                display: b.display,
              },
        ),
        score: h.score,
      };
    });
    process.stdout.write(JSON.stringify(items, null, 2) + "\n");
    return 0;
  }

  if (hops.length === 0) {
    process.stdout.write("(no two-hop neighbours)\n");
    return 0;
  }
  for (const h of hops) {
    const target = vault.pages.get(h.pageId);
    const title = target?.title ?? h.pageId;
    const via = h.via
      .map((b) =>
        b.kind === "page"
          ? (vault.pages.get(b.pageId)?.title ?? b.pageId)
          : `[[${b.display}]]`,
      )
      .join(", ");
    process.stdout.write(`- ${title}  [score=${h.score}]  via: ${via}\n`);
  }
  return 0;
}

const PUB_HELP = `oak pub — publish branch tooling

Usage:
  oak pub                    Show this help
  oak pub init               Create the publish orphan branch and check
                             out a worktree at <vault>/.git/oak-publish
  oak pub build              Refresh the publishable vault snapshot in
                             the publish worktree, commit, and push
  oak pub status             Show whether the publish branch and
                             worktree exist

Options for \`oak pub build\`:
  --branch <name>            Publish branch name (default: ${DEFAULT_PUBLISH_BRANCH})
  --remote <name>            Git remote (default: origin)
  --no-push                  Commit locally without pushing
`;

function resolveTemplateDir(): string {
  // CLI declares @oak/publish-template as a workspace dep. Resolve via
  // the package.json so we work whether installed flat, hoisted, or
  // running directly out of the monorepo.
  const require = createRequire(import.meta.url);
  try {
    const pkgPath = require.resolve("@oak/publish-template/package.json");
    return dirname(pkgPath);
  } catch {
    // Fallback for monorepo-from-source running before pnpm install:
    // packages/cli/dist/index.js -> ../../publish-template
    const here = fileURLToPath(import.meta.url);
    return resolve(dirname(here), "..", "..", "publish-template");
  }
}

async function cmdPub(
  vaultPath: string,
  positional: string[],
  flags: Record<string, string | boolean>,
  json: boolean,
): Promise<number> {
  const sub = positional[0];
  if (!sub) {
    process.stdout.write(PUB_HELP);
    return 0;
  }
  try {
    switch (sub) {
      case "init":
        return await cmdPubInit(vaultPath, flags, json);
      case "build":
        return await cmdPubBuild(vaultPath, flags, json);
      case "status":
        return await cmdPubStatus(vaultPath, flags, json);
      default:
        process.stderr.write(
          `Unknown pub subcommand: ${sub}. Try \`oak pub\` for help.\n`,
        );
        return 1;
    }
  } catch (err) {
    if (err instanceof PubError) {
      if (json) {
        process.stdout.write(
          JSON.stringify({ error: err.code, message: err.message }, null, 2) +
            "\n",
        );
      } else {
        process.stderr.write(`oak pub: ${err.message}\n`);
      }
      return 1;
    }
    throw err;
  }
}

async function cmdPubInit(
  vaultPath: string,
  flags: Record<string, string | boolean>,
  json: boolean,
): Promise<number> {
  const branch = getString(flags, "branch") ?? DEFAULT_PUBLISH_BRANCH;
  const result = await pubInit({
    vaultRoot: vaultPath,
    templateDir: resolveTemplateDir(),
    branch,
  });
  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  }
  if (result.branchCreated) {
    process.stdout.write(
      `Created publish branch \`${result.branch}\` (${result.initialCommit?.slice(0, 7)})\n`,
    );
  } else {
    process.stdout.write(
      `Reused publish branch \`${result.branch}\`\n`,
    );
  }
  process.stdout.write(`Worktree:    ${result.worktreePath}\n`);
  if (result.scaffolded.length > 0) {
    process.stdout.write(`Scaffolded ${result.scaffolded.length} file(s)\n`);
    for (const f of result.scaffolded) {
      process.stdout.write(`  + ${f}\n`);
    }
  } else {
    process.stdout.write(`Scaffold skipped (branch already populated)\n`);
  }
  if (result.rewrittenDevDeps.length > 0) {
    process.stdout.write(
      `\nDevelopment install detected: rewrote ${result.rewrittenDevDeps.length} workspace ref(s) to local file: paths.\n`,
    );
    for (const r of result.rewrittenDevDeps) {
      process.stdout.write(`  ${r.file}: ${r.name} -> file:${r.resolvedTo}\n`);
    }
    process.stdout.write(
      `Note: file: refs are machine-specific. Re-run \`oak pub init\` after publishing oak to npm, or edit package.json by hand.\n`,
    );
  }
  return 0;
}

async function cmdPubBuild(
  vaultPath: string,
  flags: Record<string, string | boolean>,
  json: boolean,
): Promise<number> {
  const branch = getString(flags, "branch") ?? DEFAULT_PUBLISH_BRANCH;
  const remote = getString(flags, "remote") ?? "origin";
  const push = !getBool(flags, "no-push");

  const result = await pubBuild({
    vaultRoot: vaultPath,
    branch,
    remote,
    push,
  });
  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  }
  if (result.committed) {
    process.stdout.write(
      `Published ${result.publishedCommit.slice(0, 7)} to \`${result.branch}\`\n`,
    );
  } else {
    process.stdout.write(
      `No changes since last publish — \`${result.branch}\` already at ${result.publishedCommit.slice(0, 7)}\n`,
    );
  }
  process.stdout.write(
    `  source HEAD:  ${result.sourceCommit.slice(0, 7)}`,
  );
  if (result.sourceDirty) process.stdout.write(" (dirty)");
  process.stdout.write("\n");
  process.stdout.write(
    `  sync:         +${result.syncCopied} =${result.syncUnchanged} -${result.syncDeleted}\n`,
  );
  process.stdout.write(
    `  pushed:       ${result.pushed ? `${result.pushedRemote}/${result.branch}` : "no"}\n`,
  );
  return 0;
}

async function cmdPubStatus(
  vaultPath: string,
  flags: Record<string, string | boolean>,
  json: boolean,
): Promise<number> {
  const branch = getString(flags, "branch") ?? DEFAULT_PUBLISH_BRANCH;
  const status = await pubStatus(vaultPath, branch);
  if (json) {
    process.stdout.write(JSON.stringify(status, null, 2) + "\n");
    return 0;
  }
  process.stdout.write(`branch:    ${status.branch}\n`);
  process.stdout.write(
    `exists:    ${status.branchExists ? "yes" : "no — run `oak pub init`"}\n`,
  );
  process.stdout.write(`worktree:  ${status.worktreePath}\n`);
  process.stdout.write(
    `           ${status.worktreeExists ? "present" : "missing — run `oak pub init`"}\n`,
  );
  return 0;
}

async function cmdSnapshot(
  vaultPath: string,
  flags: Record<string, string | boolean>,
  json: boolean,
): Promise<number> {
  const message = getString(flags, "message");
  const result = await snapshot(vaultPath, message ? { message } : {});
  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  }
  if (!result.committed) {
    process.stdout.write("(no changes — nothing to snapshot)\n");
    return 0;
  }
  process.stdout.write(`Snapshotted ${result.hash?.slice(0, 7)} ${result.message}\n`);
  return 0;
}

async function cmdCheckpoint(
  vaultPath: string,
  positional: string[],
  json: boolean,
): Promise<number> {
  const message = positional.join(" ").trim();
  if (!message) {
    process.stderr.write("Usage: oak checkpoint <message>\n");
    return 1;
  }
  const result = await checkpoint(vaultPath, message);
  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  }
  if (!result.committed) {
    process.stdout.write(`(no changes — checkpoint label \`${message}\` not recorded)\n`);
    return 0;
  }
  process.stdout.write(
    `Checkpointed ${result.hash?.slice(0, 7)} ${result.message}\n`,
  );
  return 0;
}

async function cmdLog(
  vaultPath: string,
  flags: Record<string, string | boolean>,
  json: boolean,
): Promise<number> {
  const nStr = getString(flags, "n");
  const n = nStr ? Math.max(1, parseInt(nStr, 10)) : 10;
  const commits = await recentCommits(vaultPath, n);
  if (json) {
    process.stdout.write(JSON.stringify(commits, null, 2) + "\n");
    return 0;
  }
  if (commits.length === 0) {
    process.stdout.write("(no commits — run `oak init` or make changes)\n");
    return 0;
  }
  for (const c of commits) {
    process.stdout.write(`${c.shortHash}  ${c.authorDate}  ${c.subject}\n`);
  }
  return 0;
}

async function cmdMount(
  vaultPath: string,
  positional: string[],
  flags: Record<string, string | boolean>,
  json: boolean,
): Promise<number> {
  const sub = positional[0];
  if (!sub) {
    process.stderr.write(
      "Missing mount subcommand. Try `oak mount add|list|doctor`.\n",
    );
    return 1;
  }
  switch (sub) {
    case "add":
      return await cmdMountAdd(vaultPath, positional.slice(1), flags, json);
    case "list":
      return await cmdMountList(vaultPath, json);
    case "doctor":
      return await cmdMountDoctor(vaultPath, json);
    default:
      process.stderr.write(`Unknown mount subcommand: ${sub}\n`);
      return 1;
  }
}

async function cmdMountAdd(
  vaultPath: string,
  positional: string[],
  flags: Record<string, string | boolean>,
  json: boolean,
): Promise<number> {
  const id = positional[0];
  const target = positional[1];
  if (!id || !target) {
    process.stderr.write("Usage: oak mount add <id> <path>\n");
    return 1;
  }
  const mode = getString(flags, "mode");
  const gitPolicy = getString(flags, "git-policy");

  try {
    const entry = await addMount(vaultPath, {
      id,
      target,
      ...(mode === "readwrite" || mode === "readonly" ? { mode } : {}),
      ...(gitPolicy === "ignore" || gitPolicy === "status-only"
        ? { gitPolicy }
        : {}),
    });
    if (json) {
      process.stdout.write(JSON.stringify(entry, null, 2) + "\n");
    } else {
      process.stdout.write(
        `Mounted \`${entry.id}\`\n  link:   ${entry.linkPath}\n  target: ${entry.targetPath}\n  mode:   ${entry.mode}\n`,
      );
    }
    return 0;
  } catch (err) {
    process.stderr.write(`oak mount add: ${(err as Error).message}\n`);
    return 1;
  }
}

async function cmdMountList(
  vaultPath: string,
  json: boolean,
): Promise<number> {
  const statuses = await listMountStatus(vaultPath);
  if (json) {
    process.stdout.write(JSON.stringify(statuses, null, 2) + "\n");
    return 0;
  }
  if (statuses.length === 0) {
    process.stdout.write("(no mounts configured)\n");
    return 0;
  }
  for (const s of statuses) {
    const linkOk = s.linkExists ? "ok" : "MISSING";
    const targetOk = s.targetExists ? "ok" : "MISSING";
    process.stdout.write(
      `- ${s.entry.id}\n` +
        `    link:   ${s.entry.linkPath} [${linkOk}]\n` +
        `    target: ${s.entry.targetPath} [${targetOk}]\n` +
        `    mode:   ${s.entry.mode}, gitPolicy: ${s.entry.gitPolicy}\n`,
    );
  }
  return 0;
}

async function cmdMountDoctor(
  vaultPath: string,
  json: boolean,
): Promise<number> {
  const issues = await mountDoctor(vaultPath);
  const errors = issues.filter((i) => i.severity === "error");
  if (json) {
    process.stdout.write(JSON.stringify(issues, null, 2) + "\n");
  } else if (issues.length === 0) {
    process.stdout.write("All mounts healthy.\n");
  } else {
    for (const i of issues) {
      process.stdout.write(`${i.severity}: [${i.code}] ${i.message}\n`);
    }
  }
  return errors.length > 0 ? 1 : 0;
}

async function cmdAgent(
  vaultPath: string,
  positional: string[],
  flags: Record<string, string | boolean>,
  json: boolean,
): Promise<number> {
  const sub = positional[0];
  if (!sub) {
    process.stderr.write(
      "Missing agent subcommand. Try `oak agent start|list|diff|accept|reject|context`.\n",
    );
    return 1;
  }
  const args = positional.slice(1);
  try {
    switch (sub) {
      case "start":
        return await cmdAgentStart(vaultPath, args, json);
      case "list":
        return await cmdAgentList(vaultPath, json);
      case "diff":
        return await cmdAgentDiff(vaultPath, args, flags, json);
      case "accept":
        return await cmdAgentAccept(vaultPath, args, flags, json);
      case "reject":
        return await cmdAgentReject(vaultPath, args, json);
      case "context":
        return await cmdAgentContext(vaultPath, flags, json);
      default:
        process.stderr.write(`Unknown agent subcommand: ${sub}\n`);
        return 1;
    }
  } catch (err) {
    if (err instanceof AgentError) {
      process.stderr.write(`oak agent: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

async function cmdAgentStart(
  vaultPath: string,
  args: string[],
  json: boolean,
): Promise<number> {
  const taskId = args[0];
  if (!taskId) {
    process.stderr.write("Usage: oak agent start <task-id>\n");
    return 1;
  }
  const result = await startAgentTask(vaultPath, { taskId });
  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  }
  process.stdout.write(`Started agent task \`${result.taskId}\`\n`);
  process.stdout.write(`  branch:        ${result.branch}\n`);
  process.stdout.write(`  worktree:      ${result.worktreePath}\n`);
  process.stdout.write(`  base commit:   ${result.baseCommit.slice(0, 12)}\n`);
  if (result.preCheckpoint) {
    process.stdout.write(`  checkpoint:    ${result.preCheckpoint.slice(0, 7)}\n`);
  }
  return 0;
}

async function cmdAgentList(
  vaultPath: string,
  json: boolean,
): Promise<number> {
  const tasks = await listAgentTasks(vaultPath);
  if (json) {
    process.stdout.write(JSON.stringify(tasks, null, 2) + "\n");
    return 0;
  }
  if (tasks.length === 0) {
    process.stdout.write("(no active agent tasks)\n");
    return 0;
  }
  for (const t of tasks) {
    process.stdout.write(`- ${t.taskId}\n    branch:   ${t.branch}\n    worktree: ${t.worktreePath}\n`);
  }
  return 0;
}

async function cmdAgentDiff(
  vaultPath: string,
  args: string[],
  flags: Record<string, string | boolean>,
  json: boolean,
): Promise<number> {
  const taskId = args[0];
  if (!taskId) {
    process.stderr.write("Usage: oak agent diff <task-id>\n");
    return 1;
  }
  const result = await reviewAgentTask(vaultPath, taskId);
  const omitDiff = getBool(flags, "summary");
  if (json) {
    process.stdout.write(
      JSON.stringify(
        omitDiff ? { ...result, diff: undefined } : result,
        null,
        2,
      ) + "\n",
    );
    return 0;
  }
  process.stdout.write(`agent task \`${result.taskId}\` (${result.branch})\n`);
  process.stdout.write(
    `  base ${result.base.slice(0, 12)}…  head ${result.head.slice(0, 12)}…\n`,
  );
  process.stdout.write(`  changed files (${result.changedFiles.length}):\n`);
  for (const f of result.changedFiles) {
    process.stdout.write(`    ${f.status}\t${f.path}\n`);
  }
  const errs = result.validation.errors.length;
  const warns = result.validation.warnings.length;
  process.stdout.write(`  validation: ${errs} error(s), ${warns} warning(s)\n`);
  if (!omitDiff && result.diff.length > 0) {
    process.stdout.write("\n");
    process.stdout.write(result.diff);
    if (!result.diff.endsWith("\n")) process.stdout.write("\n");
  }
  return errs > 0 ? 1 : 0;
}

async function cmdAgentAccept(
  vaultPath: string,
  args: string[],
  flags: Record<string, string | boolean>,
  json: boolean,
): Promise<number> {
  const taskId = args[0];
  if (!taskId) {
    process.stderr.write("Usage: oak agent accept <task-id>\n");
    return 1;
  }
  const skipValidation = getBool(flags, "skip-validation");
  const result = await acceptAgentTask(vaultPath, taskId, { skipValidation });
  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  }
  process.stdout.write(
    `Merged agent task \`${result.taskId}\` -> ${result.mergeCommit.slice(0, 7)}\n`,
  );
  return 0;
}

async function cmdAgentReject(
  vaultPath: string,
  args: string[],
  json: boolean,
): Promise<number> {
  const taskId = args[0];
  if (!taskId) {
    process.stderr.write("Usage: oak agent reject <task-id>\n");
    return 1;
  }
  const result = await rejectAgentTask(vaultPath, taskId);
  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return 0;
  }
  process.stdout.write(
    `Rejected agent task \`${result.taskId}\` (branch ${result.branch} discarded)\n`,
  );
  return 0;
}

async function cmdAgentContext(
  vaultPath: string,
  flags: Record<string, string | boolean>,
  _json: boolean,
): Promise<number> {
  const focus = getString(flags, "focus");
  const focusIds = focus
    ? focus.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const vault = await parseVault(vaultPath);
  const graph = buildGraph(vault);
  const ctx = agentContext(vault, graph, {
    ...(focusIds.length > 0 ? { focusIds } : {}),
  });
  // Always machine-readable: this output is meant to feed an LLM.
  process.stdout.write(JSON.stringify(ctx, null, 2) + "\n");
  return 0;
}

async function cmdAgenda(
  vaultPath: string,
  positional: string[],
  flags: Record<string, string | boolean>,
  json: boolean,
): Promise<number> {
  const sub = positional[0] ?? "a";
  const args = positional.slice(1);

  if (sub === "done") {
    return await cmdAgendaDone(vaultPath, args, json);
  }

  const config = await loadAgendaConfig(vaultPath);
  const vault = await parseVault(vaultPath);
  const entries = extractVaultAgendaEntries(vault, config);
  const now = new Date();

  let query: AgendaQuery;
  switch (sub) {
    case "a": {
      const fromArg = getString(flags, "from");
      const daysArg = getString(flags, "days");
      let days = 7;
      if (daysArg !== undefined) {
        // `parseInt` happily returns `NaN` on garbage input. Without a
        // guard `--days=foo` silently builds a 0-bucket weekly view
        // and exits 0; reject explicitly so the user sees the typo.
        if (!/^\d+$/.test(daysArg)) {
          process.stderr.write(
            `oak agenda: --days expects a positive integer, got \`${daysArg}\`\n`,
          );
          return 1;
        }
        days = Math.max(1, parseInt(daysArg, 10));
      }
      const today = todayIso(now);
      const from = fromArg
        ? fromArg
        : startOfWeek(today, config.weekStartsOn);
      query = { kind: "weekly", from, days };
      break;
    }
    case "t": {
      const keyword = getString(flags, "keyword");
      const includeDone = getBool(flags, "all");
      query = {
        kind: "todo",
        ...(keyword !== undefined ? { keyword } : {}),
        ...(includeDone ? { includeDone: true } : {}),
      };
      break;
    }
    case "m": {
      const expr = args.join(" ").trim();
      if (!expr) {
        process.stderr.write("Usage: oak agenda m <match-expression>\n");
        return 1;
      }
      query = { kind: "match", expression: expr };
      break;
    }
    case "s": {
      const regex = args.join(" ").trim();
      if (!regex) {
        process.stderr.write("Usage: oak agenda s <regex>\n");
        return 1;
      }
      query = { kind: "search", regex };
      break;
    }
    default:
      process.stderr.write(
        `Unknown agenda subcommand: ${sub}. Try a|t|m|s|done.\n`,
      );
      return 1;
  }

  let view: AgendaView;
  try {
    view = runAgenda(entries, query, config, now);
  } catch (err) {
    process.stderr.write(`oak agenda: ${(err as Error).message}\n`);
    return 1;
  }

  if (json) {
    process.stdout.write(
      JSON.stringify(serialiseView(view), null, 2) + "\n",
    );
    return 0;
  }
  process.stdout.write(renderAgendaView(view));
  return 0;
}

async function cmdAgendaDone(
  vaultPath: string,
  args: string[],
  json: boolean,
): Promise<number> {
  const ref = args[0];
  if (!ref) {
    process.stderr.write("Usage: oak agenda done <relPath>:<line>\n");
    return 1;
  }
  const colon = ref.lastIndexOf(":");
  if (colon === -1) {
    process.stderr.write(
      "Usage: oak agenda done <relPath>:<line> (missing line number)\n",
    );
    return 1;
  }
  const relPath = ref.slice(0, colon);
  const line = parseInt(ref.slice(colon + 1), 10);
  if (!Number.isFinite(line)) {
    process.stderr.write("oak agenda done: line must be a number\n");
    return 1;
  }

  const config = await loadAgendaConfig(vaultPath);
  const vault = await parseVault(vaultPath);
  const entries = extractVaultAgendaEntries(vault, config);
  const target = entries.find(
    (e) => e.relPath === relPath && e.line === line,
  );
  if (!target) {
    process.stderr.write(
      `oak agenda done: no entry at ${relPath}:${line}\n`,
    );
    return 1;
  }
  try {
    const result = await markDone(
      target.filePath,
      target.entryId,
      config,
      undefined,
      target.relPath,
      vaultPath,
    );
    if (json) {
      process.stdout.write(
        JSON.stringify(
          {
            filePath: result.filePath,
            entryId: result.entryId,
            repeated: result.repeated,
          },
          null,
          2,
        ) + "\n",
      );
      return 0;
    }
    process.stdout.write(
      `${result.repeated ? "Advanced repeater on" : "Marked DONE"} ${target.title}\n` +
        `  file: ${target.relPath}:${target.line}\n`,
    );
    return 0;
  } catch (err) {
    if (err instanceof WriteBackError) {
      process.stderr.write(`oak agenda done: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

async function cmdMigrate(
  vaultPath: string,
  positional: string[],
  flags: Record<string, string | boolean>,
  json: boolean,
): Promise<number> {
  const sub = positional[0];
  if (sub !== "timestamps") {
    process.stderr.write("Usage: oak migrate timestamps [--dry-run]\n");
    return 1;
  }
  const dryRun = getBool(flags, "dry-run");
  const report = await migrateTimestamps({ vaultRoot: vaultPath, dryRun });
  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return 0;
  }
  if (report.changed === 0) {
    process.stdout.write(
      `migrate timestamps: scanned ${report.scanned} page(s); nothing to fill.\n`,
    );
    return 0;
  }
  const prefix = dryRun ? "[dry-run] would update" : "updated";
  for (const entry of report.entries) {
    const parts: string[] = [];
    if (entry.added.created !== undefined) {
      parts.push(`created=${entry.added.created}`);
    }
    if (entry.added.modified !== undefined) {
      parts.push(`modified=${entry.added.modified}`);
    }
    process.stdout.write(`${prefix} ${entry.relPath}  ${parts.join(" ")}\n`);
  }
  process.stdout.write(
    `\nmigrate timestamps: ${report.changed} changed, ${report.unchanged} unchanged, ${report.scanned} scanned${dryRun ? " (dry-run, no files written)" : ""}.\n`,
  );
  return 0;
}

function serialiseView(view: AgendaView): unknown {
  return {
    query: view.query,
    generatedAt: view.generatedAt,
    buckets: view.buckets.map((b) => ({
      key: b.key,
      label: b.label,
      items: b.items.map((it) => ({
        entryId: it.entry.entryId,
        relPath: it.entry.relPath,
        line: it.entry.line,
        title: it.entry.title,
        todoState: it.entry.todoState,
        priority: it.entry.priority,
        category: it.entry.category,
        tags: it.entry.tags,
        scheduled: it.entry.scheduled?.iso ?? null,
        deadline: it.entry.deadline?.iso ?? null,
        date: it.date,
        marker: it.marker,
        daysDelta: it.daysDelta,
        time: it.time,
        endTime: it.endTime,
      })),
    })),
  };
}

function renderAgendaView(view: AgendaView): string {
  const lines: string[] = [];
  for (const bucket of view.buckets) {
    lines.push(bucket.label);
    if (bucket.items.length === 0) {
      lines.push("  (nothing)");
    } else {
      for (const item of bucket.items) {
        lines.push(`  ${renderItem(item)}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

function renderItem(item: AgendaItem): string {
  const cat = padRight(item.entry.category, 10);
  const time = item.time
    ? item.endTime
      ? padRight(`${item.time}-${item.endTime}`, 12)
      : padRight(`${item.time}......`, 12)
    : padRight("", 12);
  const marker = renderMarker(item);
  const state = item.entry.todoState
    ? padRight(item.entry.todoState, 8)
    : padRight("", 8);
  const pri = item.entry.priority ? `[#${item.entry.priority}] ` : "";
  const tags = item.entry.tags.length > 0
    ? `  :${item.entry.tags.join(":")}:`
    : "";
  return `${cat}  ${time}${marker}${state}${pri}${item.entry.title}${tags}`;
}

function padRight(s: string, n: number): string {
  if (s.length >= n) return s;
  return s + " ".repeat(n - s.length);
}

function renderMarker(item: AgendaItem): string {
  if (!item.marker) return padRight("", 14);
  switch (item.marker) {
    case "scheduled":
      return padRight("Scheduled:", 14);
    case "scheduled-overdue":
      return padRight(`Sched.${item.daysDelta}xD:`, 14);
    case "deadline":
      return padRight("Deadline:", 14);
    case "deadline-warning":
      return padRight(`In ${item.daysDelta} d.:`, 14);
    case "deadline-overdue":
      return padRight(`${item.daysDelta} d. ago:`, 14);
    case "timestamp":
      return padRight("", 14);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exit(code);
  },
  (err) => {
    process.stderr.write(`oak: ${(err as Error).stack ?? err}\n`);
    process.exit(2);
  },
);
