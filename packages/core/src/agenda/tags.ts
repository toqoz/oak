// Tag inheritance helper.
//
// Effective tags = (frontmatter tags + frontmatter category-as-tag +
//                   ancestor heading own-tags + own tags)
// minus config.tagsExcludeFromInheritance, deduplicated, original
// order preserved.

import type { AgendaConfig } from "./types.js";

export function buildEffectiveTags(
  ownTags: string[],
  ancestorTags: string[][],
  frontmatterTags: string[],
  frontmatterCategory: string | undefined,
  config: AgendaConfig,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const exclude = new Set(config.tagsExcludeFromInheritance);

  const push = (t: string) => {
    if (!t) return;
    if (exclude.has(t)) return;
    if (seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };

  if (config.useTagInheritance) {
    for (const t of frontmatterTags) push(t);
    if (frontmatterCategory) push(frontmatterCategory);
    for (const ancestor of ancestorTags) {
      for (const t of ancestor) push(t);
    }
  }
  for (const t of ownTags) push(t);
  return out;
}

// Coerce frontmatter `tags` into a string array. Accepts either a list
// (`tags: [a, b]`) or a comma/space-separated scalar (`tags: a b c`).
export function coerceFrontmatterTags(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
  }
  if (typeof value === "string") {
    return value
      .split(/[\s,]+/)
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
  }
  return [];
}
