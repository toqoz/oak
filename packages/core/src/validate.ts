// Vault-level validation. Aggregates issues from parsing, indexing,
// and link resolution. Used by `oak validate` and as a publish gate.

import type { Graph, Issue, Vault } from "./types.js";
import { isAssetTarget } from "./assets.js";

function publicLike(visibility: string): boolean {
  return visibility === "public" || visibility === "unlisted";
}

export function validateVault(vault: Vault, graph: Graph): Issue[] {
  const issues: Issue[] = [];

  // Vault-level issues from parsing (mounts, etc.)
  for (const i of vault.issues) issues.push(i);

  // Per-page parse issues
  for (const page of vault.pages.values()) {
    for (const i of page.parseIssues) issues.push(i);
  }

  // Conflicts
  for (const [key, ids] of vault.titleConflicts) {
    issues.push({
      severity: "error",
      code: "duplicate-title",
      message: `Duplicate title \`${key}\` across pages: ${ids.join(", ")}`,
    });
  }
  for (const [key, ids] of vault.aliasConflicts) {
    issues.push({
      severity: "error",
      code: "duplicate-alias",
      message: `Duplicate alias \`${key}\` across pages: ${ids.join(", ")}`,
    });
  }
  for (const [key, ids] of vault.slugConflicts) {
    issues.push({
      severity: "error",
      code: "slug-collision",
      message: `Slug collision \`${key}\` across pages: ${ids.join(", ")}`,
    });
  }
  for (const [key, ids] of vault.basenameConflicts) {
    issues.push({
      severity: "warning",
      code: "duplicate-basename",
      message: `Duplicate basename \`${key}\` across pages: ${ids.join(", ")}`,
    });
  }

  // Link-level checks
  for (const page of vault.pages.values()) {
    const outgoing = graph.outgoing.get(page.id) ?? [];
    const isPublic = publicLike(page.visibility);

    for (const link of outgoing) {
      const r = link.resolution;
      if (r.status === "resolved") {
        const target = vault.pages.get(r.targetId);
        if (!target) continue;
        if (isPublic && target.visibility === "private") {
          issues.push({
            severity: "error",
            code: "private-leak",
            message: `${page.visibility} page \`${page.titlePlain}\` links to private page \`${target.titlePlain}\` (line ${link.line})`,
            pageId: page.id,
            filePath: page.filePath,
          });
        }
      } else if (r.status === "external") {
        if (isPublic) {
          issues.push({
            severity: "error",
            code: "external-leak",
            message: `${page.visibility} page \`${page.titlePlain}\` links to external document \`${link.target}\` (line ${link.line})`,
            pageId: page.id,
            filePath: page.filePath,
          });
        }
      } else if (r.status === "invalid") {
        issues.push({
          severity: "error",
          code: "invalid-link",
          message: `Invalid link in \`${page.titlePlain}\`: ${r.reason} (line ${link.line})`,
          pageId: page.id,
          filePath: page.filePath,
        });
      } else if (r.status === "unresolved" && link.isEmbed) {
        // Asset embeds (image/svg/etc.) are resolved at publish time
        // against the filesystem, not via the page link tables — so
        // they're not "unresolved embeds" in the validation sense.
        if (isAssetTarget(link.target)) continue;
        // Page embeds must resolve; otherwise the rendered page would
        // have a missing transclusion target.
        issues.push({
          severity: "error",
          code: "unresolved-embed",
          message: `Unresolved embed in \`${page.titlePlain}\`: ![[${link.target}]] (line ${link.line})`,
          pageId: page.id,
          filePath: page.filePath,
        });
      }
      // Plain unresolved wikilinks are red links — a normal state, not an error.
    }
  }

  return issues;
}

export function partitionIssues(
  issues: Issue[],
): { errors: Issue[]; warnings: Issue[] } {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  for (const i of issues) {
    if (i.severity === "error") errors.push(i);
    else warnings.push(i);
  }
  return { errors, warnings };
}
