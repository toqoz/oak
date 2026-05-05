// Resolve a user-supplied identifier (title, alias, basename, slug, id, or path)
// to a page id within a vault.

import type { Vault } from "@oak/core";
import { normalizeKey } from "@oak/core";

export type LookupResult =
  | { status: "found"; pageId: string }
  | { status: "not-found" }
  | { status: "ambiguous"; candidates: string[] };

export function lookupPage(vault: Vault, query: string): LookupResult {
  // Exact id
  if (vault.pages.has(query)) {
    return { status: "found", pageId: query };
  }

  const key = normalizeKey(query);

  // Try title -> alias -> slug -> basename -> path-like
  for (const map of [
    vault.byTitle,
    vault.byAlias,
    vault.bySlug,
    vault.byBasename,
  ]) {
    const id = map.get(key);
    if (id !== undefined && vault.pages.has(id)) {
      return { status: "found", pageId: id };
    }
  }

  const noExt = query.replace(/\.md$/i, "").replace(/^\.\//, "");
  const pathHit = vault.byVaultRelPath.get(normalizeKey(noExt));
  if (pathHit !== undefined && vault.pages.has(pathHit)) {
    return { status: "found", pageId: pathHit };
  }

  return { status: "not-found" };
}
