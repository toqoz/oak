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

import { resolve } from "node:path";
import { mkdir, writeFile, access } from "node:fs/promises";
import {
  addMount,
  buildGraph,
  getBacklinks,
  getTwoHopLinks,
  listMountStatus,
  mountDoctor,
  parseVault,
  partitionIssues,
  publish,
  PublishError,
  validateVault,
  writeIndex,
} from "@oak/core";

import { getBool, getString, parseArgs } from "./args.js";
import { lookupPage } from "./lookup.js";

const HELP = `oak — local-file-first knowledge graph (v1, phase 1)

Usage:
  oak <command> [options]

Commands:
  init                       Initialize a vault in the current directory
  index                      Parse the vault and write .oak/index.sqlite
  validate                   Run vault validation; exits non-zero on errors
  status                     Show pending vault changes (stub in v1)
  backlinks <page>           List incoming links for a page
  twohop <page>              List two-hop neighbours for a page
  publish [--base-url U]     Render public/unlisted pages to public-site/
  checkpoint <msg>           Tag the vault state via git (Phase 4, not yet)
  mount add <id> <path>      Mount an external directory at _external/<id>
  mount list                 Show configured mounts and their health
  mount doctor               Report broken / overlapping mounts

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
    case "publish":
      return await cmdPublish(vaultPath, parsed.flags, json);
    case "checkpoint":
      process.stderr.write(
        `\`oak ${parsed.command}\` is not implemented yet.\n`,
      );
      return 2;
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
  const gitignore = resolve(vaultPath, ".gitignore");
  if (!(await exists(gitignore))) {
    await writeFile(
      gitignore,
      [
        ".oak/index.sqlite",
        ".oak/tmp/",
        "_external/",
        "public-site/",
        ".obsidian/workspace*",
      ].join("\n") + "\n",
      "utf8",
    );
  }
  process.stdout.write(`Initialized oak vault at ${vaultPath}\n`);
  return 0;
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
  // Minimal: report parse/validate counts. Real git-status integration is Phase 4.
  const vault = await parseVault(vaultPath);
  const graph = buildGraph(vault);
  const { errors, warnings } = partitionIssues(validateVault(vault, graph));
  if (json) {
    process.stdout.write(
      JSON.stringify(
        {
          root: vault.rootPath,
          pages: vault.pages.size,
          errors: errors.length,
          warnings: warnings.length,
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    process.stdout.write(`Vault: ${vault.rootPath}\n`);
    process.stdout.write(`  pages:    ${vault.pages.size}\n`);
    process.stdout.write(`  errors:   ${errors.length}\n`);
    process.stdout.write(`  warnings: ${warnings.length}\n`);
    process.stdout.write(`  git:      (not implemented in Phase 1)\n`);
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
        via: h.via.map((id) => ({
          id,
          title: vault.pages.get(id)?.title ?? null,
        })),
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
      .map((id) => vault.pages.get(id)?.title ?? id)
      .join(", ");
    process.stdout.write(`- ${title}  [score=${h.score}]  via: ${via}\n`);
  }
  return 0;
}

async function cmdPublish(
  vaultPath: string,
  flags: Record<string, string | boolean>,
  json: boolean,
): Promise<number> {
  const vault = await parseVault(vaultPath);
  const graph = buildGraph(vault);
  const issues = validateVault(vault, graph);

  const baseUrl = getString(flags, "base-url");
  const outputDir = getString(flags, "output");
  const dryRun = getBool(flags, "dry-run");

  try {
    const stats = await publish(vault, graph, issues, {
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      ...(outputDir !== undefined ? { outputDir } : {}),
      dryRun,
    });
    if (json) {
      process.stdout.write(JSON.stringify(stats, null, 2) + "\n");
      return 0;
    }
    process.stdout.write(
      `${dryRun ? "(dry-run) " : ""}Published to ${stats.outputDir}\n`,
    );
    process.stdout.write(`  baseUrl:        ${stats.baseUrl}\n`);
    process.stdout.write(`  pages:          ${stats.pages.length}\n`);
    process.stdout.write(`  assets:         ${stats.assets.length}\n`);
    process.stdout.write(`  removed pages:  ${stats.removedPages.length}\n`);
    process.stdout.write(`  removed assets: ${stats.removedAssets.length}\n`);
    process.stdout.write(`  manifest:       ${stats.manifestPath}\n`);
    return 0;
  } catch (err) {
    if (err instanceof PublishError) {
      if (json) {
        process.stdout.write(
          JSON.stringify({ blocked: true, errors: err.issues }, null, 2) +
            "\n",
        );
      } else {
        process.stderr.write(`publish blocked:\n`);
        for (const i of err.issues) {
          const where = i.filePath ? ` (${i.filePath})` : "";
          process.stderr.write(`  [${i.code}] ${i.message}${where}\n`);
        }
      }
      return 1;
    }
    throw err;
  }
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
  const llmPolicy = getString(flags, "llm-policy");

  try {
    const entry = await addMount(vaultPath, {
      id,
      target,
      ...(mode === "readwrite" || mode === "readonly" ? { mode } : {}),
      ...(gitPolicy === "ignore" || gitPolicy === "status-only"
        ? { gitPolicy }
        : {}),
      ...(llmPolicy === "allow" ||
      llmPolicy === "deny" ||
      llmPolicy === "summary-only"
        ? { llmPolicy }
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
        `    mode:   ${s.entry.mode}, gitPolicy: ${s.entry.gitPolicy}, llm: ${s.entry.llmPolicy}\n`,
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

main(process.argv.slice(2)).then(
  (code) => {
    process.exit(code);
  },
  (err) => {
    process.stderr.write(`oak: ${(err as Error).stack ?? err}\n`);
    process.exit(2);
  },
);
