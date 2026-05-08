// Tag inheritance helper.
//
// Effective tags = (ancestor heading own-tags + own tags) minus
// config.tagsExcludeFromInheritance, deduplicated, original order
// preserved.
//
// File-wide defaults (frontmatter `tags`/`category`, `#+FILETAGS:`) are
// intentionally NOT supported — write a top-level heading with the
// desired tags and the rest of the file inherits via the ancestor
// chain. Filename serves as the default category; per-heading override
// goes through `:PROPERTIES: :CATEGORY:`.

import type { AgendaConfig } from "./types.js";

export function buildEffectiveTags(
  ownTags: string[],
  ancestorTags: string[][],
  config: AgendaConfig,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const exclude = new Set(config.tagsExcludeFromInheritance);

  // The exclusion list applies *only* during the inheritance walk —
  // a tag that the heading owns directly must always survive. This
  // matches emacs `org-tags-exclude-from-inheritance`: a tag stays
  // on the heading that wrote it, but children don't pick it up.
  const pushAncestor = (t: string): void => {
    if (!t) return;
    if (exclude.has(t)) return;
    if (seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };

  const pushOwn = (t: string): void => {
    if (!t) return;
    if (seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };

  if (config.useTagInheritance) {
    for (const ancestor of ancestorTags) {
      for (const t of ancestor) pushAncestor(t);
    }
  }
  for (const t of ownTags) pushOwn(t);
  return out;
}
