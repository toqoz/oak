#!/usr/bin/env node
// Entry point for the `oak` CLI.

import { resolve } from "node:path";
import { mkdir, writeFile, access } from "node:fs/promises";
import {
  buildGraph,
  getBacklinks,
  getOutboundLinks,
  getTwoHopLinks,
  parseVault,
  partitionIssues,
  validateVault,
} from "@oak/core";

import { getBool, getString, parseArgs } from "./args.js";
import { lookupPage } from "./lookup.js";

const HELP = `oak — local-file-first knowledge graph (v1, phase 1)

Usage:
  oak <command> [options]

Commands:
  init                       Initialize a vault in the current directory
  index                      Parse the vault and print a summary
  validate                   Run vault validation; exits non-zero on errors
  status                     Show pending vault changes (stub in v1)
  backlinks <page>           List incoming links for a page
  twohop <page>              List two-hop neighbours for a page
  publish                    Render publishable pages (Phase 3, not yet)
  checkpoint <msg>           Tag the vault state via git (Phase 4, not yet)
  mount <subcommand>         Manage external mounts (Phase 2, not yet)

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
    case "publish":
    case "checkpoint":
    case "mount":
      process.stderr.write(
        `\`oak ${parsed.command}\` is not implemented in Phase 1.\n`,
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
  if (json) {
    const summary = {
      root: vault.rootPath,
      pages: vault.pages.size,
      externals: vault.externals.size,
      mounts: vault.mounts.size,
      issues: vault.issues.length,
    };
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    return 0;
  }
  process.stdout.write(`Vault: ${vault.rootPath}\n`);
  process.stdout.write(`  pages:     ${vault.pages.size}\n`);
  process.stdout.write(`  externals: ${vault.externals.size}\n`);
  process.stdout.write(`  mounts:    ${vault.mounts.size}\n`);
  if (vault.issues.length > 0) {
    process.stdout.write(`  issues:    ${vault.issues.length}\n`);
  }
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

main(process.argv.slice(2)).then(
  (code) => {
    process.exit(code);
  },
  (err) => {
    process.stderr.write(`oak: ${(err as Error).stack ?? err}\n`);
    process.exit(2);
  },
);
