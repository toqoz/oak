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
};

export type TwoHop = {
  pageId: string;
  via: string[];
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
  incoming: Map<string, Backlink[]>;
};
