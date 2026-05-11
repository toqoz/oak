// Core domain types for oak.
//
// Conventions:
//   - All map keys for case-insensitive lookups are stored lowercase.
//   - File paths in `OakPage.filePath` are absolute; `relPath` is vault-relative.

export type Visibility = "private" | "unlisted" | "public";
export type LlmPolicy = "allow" | "deny" | "summary-only";

export type PageFrontmatter = {
  id?: string;
  title?: string;
  aliases?: string[];
  visibility?: Visibility;
  slug?: string;
  llm?: LlmPolicy;
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
  title: string;
  aliases: string[];
  visibility: Visibility;
  slug: string;
  llm: LlmPolicy;
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
  llmPolicy: LlmPolicy;
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
