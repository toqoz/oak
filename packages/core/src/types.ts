// Core domain types for oak.
//
// Conventions:
//   - All map keys for case-insensitive lookups are stored lowercase.
//   - File paths in `OakPage.filePath` are absolute; `relPath` is vault-relative.

export type Visibility = "private" | "unlisted" | "public";

export type PageFrontmatter = {
  // Schema version of this page's frontmatter. Missing == 1 (the
  // pre-timestamp era). Latest is `LATEST_FRONTMATTER_VERSION` in
  // `./frontmatter-migrate.ts`; `oak migrate` upgrades older files
  // to the latest.
  version?: number;
  id?: string;
  aliases?: string[];
  visibility?: Visibility;
  slug?: string;
  // ISO 8601 UTC instants ("YYYY-MM-DDTHH:MM:SSZ"). Both are written by
  // oak — `created` once on page composition, `modified` whenever a
  // save changes the body or the title. Pure frontmatter edits that
  // leave the title alone (visibility flip, alias add, …) intentionally
  // skip the bump so a casual metadata tweak doesn't masquerade as a
  // content edit in agendas/feeds. Older files without these fields
  // round-trip untouched.
  created?: string;
  modified?: string;
};

export type LinkSyntax = "wiki" | "markdown";

export type RawLink = {
  syntax: LinkSyntax;
  raw: string;
  target: string;
  label: string | undefined;
  heading: string | undefined;
  isEmbed: boolean;
  start: number;
  end: number;
  line: number;
};

export type LinkResolution =
  | { status: "resolved"; targetId: string }
  | { status: "unresolved"; targetKey: string }
  | { status: "external"; externalId: string }
  | { status: "invalid"; reason: string };

export type ResolvedLink = RawLink & { resolution: LinkResolution };

export type OakPage = {
  type: "page";
  id: string;
  // Raw first-h1 text as written in the body (may include wikilinks,
  // emphasis, etc.). Falls back to the basename when the body lacks an
  // h1; a `missing-title` issue is surfaced in that case.
  title: string;
  // Decoration-stripped form of `title`. Used as the lookup/sort key,
  // the html `<title>` text, search match target, and any plain-text
  // listing.
  titlePlain: string;
  aliases: string[];
  visibility: Visibility;
  slug: string;
  filePath: string;
  relPath: string;
  basename: string;
  body: string;
  rawFrontmatter: PageFrontmatter;
  // null for files that pre-date the timestamp feature or that were
  // authored outside oak's write paths.
  created: string | null;
  modified: string | null;
  links: RawLink[];
  // Issues encountered during parsing (e.g. invalid frontmatter values).
  parseIssues: Issue[];
};

export type ExternalDocument = {
  type: "external";
  id: string;
  mountId: string;
  relPath: string;
  vaultRelPath: string;
  title: string;
  publishable: false;
};

export type MountMode = "readonly" | "readwrite";
export type GitPolicy = "ignore" | "status-only";

export type Mount = {
  id: string;
  targetPath: string;
  linkPath: string;
  mode: MountMode;
  publishable: false;
  gitPolicy: GitPolicy;
  // Resolved status: whether the symlink/path exists at parse time.
  exists: boolean;
};

export type Issue = {
  severity: "error" | "warning";
  code: string;
  message: string;
  pageId?: string;
  filePath?: string;
};

export type Backlink = {
  fromId: string;
  context: string;
  // Line number (1-based) and the original raw link text inside the source
  // page. Useful for "jump to reference" / `line N · [[Foo]]` listings.
  line: number;
  raw: string;
};

// A 2-hop bridge is either a real page or a shared red-link target. The
// latter lets two pages mention the same not-yet-written concept and find
// each other through it.
export type TwoHopBridge =
  | { kind: "page"; pageId: string }
  | { kind: "redlink"; targetKey: string; display: string };

export type TwoHop = {
  pageId: string;
  via: TwoHopBridge[];
  score: number;
};

// User-authored content placed under `_home/` in the vault. Distinct
// from `OakPage`: home content is a site/editor furniture artifact,
// not a knowledge-graph node. No id, slug, visibility, or aliases —
// nothing references it via wikilinks, and it lives at a fixed
// location (the editor home pane or the publish site's `/`).
//
// `kind` discriminates the two consumers: `editor` (rendered by the
// Obsidian home view above the auto-generated sections) and `pub`
// (rendered by the publish template at the site root). Both live in
// `_home/` so the user has one place to look.
export type HomeContent = {
  type: "home-content";
  kind: "editor" | "pub";
  filePath: string;
  relPath: string; // e.g. "_home/pub.md"
  title: string; // raw first H1; "" when the file has no heading
  titlePlain: string;
  body: string;
  // Optional timestamps from frontmatter; null when absent. The file
  // is otherwise frontmatter-free by convention.
  created: string | null;
  modified: string | null;
  // Links extracted from the body so embeds/wikilinks render via the
  // same remark pipeline pages go through. The home content itself is
  // never a wikilink target, so there is no inbound side.
  links: RawLink[];
};

export type Vault = {
  rootPath: string;
  pages: Map<string, OakPage>;
  externals: Map<string, ExternalDocument>;
  mounts: Map<string, Mount>;
  // Lookup tables for link resolution (keys lowercased).
  byTitle: Map<string, string>;
  byAlias: Map<string, string>;
  byBasename: Map<string, string>;
  bySlug: Map<string, string>;
  // Vault-relative path -> id of page or external. Key is lowercase, no `.md`.
  byVaultRelPath: Map<string, string>;
  // Conflicts surfaced during indexing.
  titleConflicts: Map<string, string[]>;
  aliasConflicts: Map<string, string[]>;
  slugConflicts: Map<string, string[]>;
  basenameConflicts: Map<string, string[]>;
  // Optional user-authored home content from `_home/`. Either field
  // is null when the corresponding file is missing. These are file
  // artifacts, not pages — they don't appear in `pages` and don't
  // participate in graph traversal.
  homePub: HomeContent | null;
  homeEditor: HomeContent | null;
  // Top-level issues (mount problems, parse failures).
  issues: Issue[];
};

export type Graph = {
  outgoing: Map<string, ResolvedLink[]>;
  // Incoming references, keyed by `linkTargetId(link)`. For resolved links
  // the key is the target page id; for unresolved (red) links it is a
  // synthetic `redlink:<normalized>` token. This way every link feeds the
  // same backlink index regardless of whether its target exists yet.
  incoming: Map<string, Backlink[]>;
};
