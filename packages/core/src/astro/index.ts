// Astro Content Layer integration for @oak/core.
//
// `oakLoader` produces one Astro content entry per publishable
// `OakPage`, with frontmatter/title/slug in `data` and the raw
// markdown in `body`. Astro's markdown pipeline (with the project's
// configured remark plugins — typically `@oak/core/remark`) renders
// the body to HTML.
//
// `astro` is an *optional* peer dependency. Only import this subpath
// when astro is installed in the consumer.

import { fileURLToPath } from "node:url";
import { isAbsolute, relative, resolve } from "node:path";

import type { Loader, LoaderContext } from "astro/loaders";

import { parseVault } from "../parse.js";
import { buildGraph } from "../graph.js";
import { processBodyAssets } from "../asset-process.js";
import { relatedView } from "../related.js";
import { collectRedlinks } from "../redlinks.js";
import type {
  InboundEntry,
  OutboundEntry,
  TwoHopEntry,
} from "../related.js";
import type { RedlinkSummary } from "../redlinks.js";
import type { OakPage, Visibility } from "../types.js";

const DEFAULT_VISIBILITY: Visibility[] = ["public", "unlisted"];
const DEFAULT_ASSET_URL_PREFIX = "/_oak";
const DEFAULT_ASSET_OUT_REL = "public/_oak";

export type OakLoaderOptions = {
  // Path to the vault root. May be absolute or relative to the
  // project's working directory.
  vault: string;
  // Which visibilities make it into the collection. Defaults to
  // public + unlisted (i.e. private pages are excluded).
  visibilityFilter?: Visibility[];
  // Override how each entry's id is computed. Default: page.slug.
  // The id determines URL routing in many Astro setups.
  idFor?: (page: OakPage) => string;
  // Where to copy referenced assets. Defaults to `<projectRoot>/public/_oak`.
  // Pass an absolute path to override.
  assetOutDir?: string;
  // URL prefix for emitted asset URLs. Defaults to "/_oak".
  assetUrlPrefix?: string;
  // Generate responsive WebP variants for png/jpg/jpeg assets and emit
  // each body image as `<img srcset>`. Requires `sharp` to be
  // installed (it ships transitively with Astro). Defaults to false.
  optimizeImages?: boolean;
  // WebP variant widths to generate. Defaults to [400, 800].
  imageWidths?: number[];
  // WebP quality 1–100. Defaults to 80.
  imageQuality?: number;
};

// What ends up in `entry.data`. The shape mirrors `RelatedView` from
// @oak/core/related so templates can render outbound, inbound, and
// 2-hop cards without doing graph traversal themselves.
export type OakEntryData = {
  oakId: string;
  title: string;
  slug: string;
  visibility: Visibility;
  aliases: string[];
  outbound: OutboundEntry[];
  inbound: InboundEntry[];
  twoHop: TwoHopEntry[];
};

function defaultIdFor(page: OakPage): string {
  return page.slug;
}

// Astro requires entry filePaths to be relative to the project root
// (not absolute, not relative to the vault). Make the absolute path
// from parseVault relative to whatever the caller declares as root.
function relativeFilePath(absolute: string, projectRoot: string): string {
  const rel = relative(projectRoot, absolute);
  // If the file lives outside projectRoot the result will start with
  // `..` — return that anyway; Astro will surface it.
  return rel.length > 0 ? rel : absolute;
}

// Internal: do one full pass over the vault and write every page into
// the store. Exported for testing.
//
// When `renderMarkdown` is provided, the page body is pre-rendered to
// HTML at load time so Astro's `render(entry)` returns a working
// Content component. The Astro content pipeline applies the
// project-configured remark plugins (including remarkOakLinks) here.
//
// Asset references in each body are resolved, copied to assetOutDir
// with content-hashed filenames, and rewritten to point at
// `<assetUrlPrefix>/<hash>.<ext>` before rendering.
export async function loadOakPagesInto(
  store: LoaderContext["store"],
  generateDigest: LoaderContext["generateDigest"],
  options: OakLoaderOptions,
  projectRoot: string = process.cwd(),
  renderMarkdown?: LoaderContext["renderMarkdown"],
): Promise<{ count: number; assetsCopied: number }> {
  // projectRoot is also used to locate sharp at runtime when
  // optimizeImages is on (see processBodyAssets call below).
  const visibilityFilter = options.visibilityFilter ?? DEFAULT_VISIBILITY;
  const visible = new Set(visibilityFilter);
  const idFor = options.idFor ?? defaultIdFor;

  const vaultRoot = isAbsolute(options.vault)
    ? options.vault
    : resolve(projectRoot, options.vault);
  const assetOutDir = options.assetOutDir
    ? isAbsolute(options.assetOutDir)
      ? options.assetOutDir
      : resolve(projectRoot, options.assetOutDir)
    : resolve(projectRoot, DEFAULT_ASSET_OUT_REL);
  const assetUrlPrefix = options.assetUrlPrefix ?? DEFAULT_ASSET_URL_PREFIX;

  const vault = await parseVault(options.vault);
  const graph = buildGraph(vault);

  store.clear();

  let count = 0;
  const writtenAssets = new Set<string>();
  for (const page of vault.pages.values()) {
    if (!visible.has(page.visibility)) continue;
    const related = relatedView(vault, graph, page.id, {
      visibilityFilter,
    });
    const data: OakEntryData = {
      oakId: page.id,
      title: page.titlePlain,
      slug: page.slug,
      visibility: page.visibility,
      aliases: page.aliases,
      outbound: related.outbound,
      inbound: related.inbound,
      twoHop: related.twoHop,
    };

    const processed = await processBodyAssets(
      page.body,
      page.filePath,
      vaultRoot,
      assetOutDir,
      assetUrlPrefix,
      {
        resolveSharpFrom: projectRoot,
        ...(options.optimizeImages !== undefined
          ? { optimize: options.optimizeImages }
          : {}),
        ...(options.imageWidths ? { widths: options.imageWidths } : {}),
        ...(options.imageQuality !== undefined
          ? { quality: options.imageQuality }
          : {}),
      },
    );
    for (const w of processed.written) writtenAssets.add(w.outputAbsPath);

    // Use the original body for storage (so consumers like search.json
    // see the source markdown), but render the rewritten body so URLs
    // in the HTML point at copied/hashed assets.
    const digest = generateDigest({ data, body: page.body });
    const rendered = renderMarkdown
      ? await renderMarkdown(processed.body)
      : undefined;
    store.set({
      id: idFor(page),
      data: data as unknown as Record<string, unknown>,
      body: page.body,
      filePath: relativeFilePath(page.filePath, projectRoot),
      digest,
      ...(rendered ? { rendered } : {}),
    });
    count++;
  }
  return { count, assetsCopied: writtenAssets.size };
}

export function oakLoader(options: OakLoaderOptions): Loader {
  return {
    name: "@oak/core/astro:oakLoader",
    load: async (ctx: LoaderContext): Promise<void> => {
      // ctx.config.root is a file:// URL pointing at the project root.
      const projectRoot = fileURLToPath(ctx.config.root);
      const reload = async (): Promise<void> => {
        const { count, assetsCopied } = await loadOakPagesInto(
          ctx.store,
          ctx.generateDigest,
          options,
          projectRoot,
          ctx.renderMarkdown,
        );
        const where = isAbsolute(options.vault)
          ? options.vault
          : relative(projectRoot, options.vault) || options.vault;
        const assetsNote =
          assetsCopied > 0 ? `, ${assetsCopied} asset(s)` : "";
        ctx.logger.info(
          `oak: loaded ${count} page(s) from ${where}${assetsNote}`,
        );
      };

      await reload();

      // In dev, ctx.watcher is a chokidar instance Astro has already
      // wired into its own change loop. We tell it about the vault so
      // edits there surface to the loader, then debounce because chokidar
      // floods 2-3 events per editor save.
      if (ctx.watcher) {
        const vaultAbs = isAbsolute(options.vault)
          ? options.vault
          : resolve(projectRoot, options.vault);
        ctx.watcher.add(vaultAbs);

        let pending: NodeJS.Timeout | null = null;
        const onChange = (path: string): void => {
          // Filter to markdown only — chokidar fires for asset writes
          // too, and parseVault only cares about .md.
          if (!path.endsWith(".md")) return;
          if (pending) clearTimeout(pending);
          pending = setTimeout(() => {
            pending = null;
            void reload().catch((e) =>
              ctx.logger.error(`oak: reload failed: ${(e as Error).message}`),
            );
          }, 80);
        };
        ctx.watcher.on("add", onChange);
        ctx.watcher.on("change", onChange);
        ctx.watcher.on("unlink", onChange);
      }
    },
  };
}

// Options for `oakHomeLoader`. Same surface as `oakLoader` minus the
// visibility/id concerns (home content is a single fixed file, not a
// page).
export type OakHomeLoaderOptions = {
  vault: string;
  assetOutDir?: string;
  assetUrlPrefix?: string;
  optimizeImages?: boolean;
  imageWidths?: number[];
  imageQuality?: number;
};

// What ends up in the homepage entry's `data`. Title is the plain
// H1 text (used as the `<title>` element); timestamps are surfaced
// for "last updated" UI but optional. The body lives on `body` like
// any other content-layer entry.
export type OakHomeData = {
  title: string;
  created: string | null;
  modified: string | null;
};

const HOME_ENTRY_ID = "pub";

// Testable inner load step: parse the vault, render the homepage, and
// write the single store entry. Returns whether anything was loaded
// so callers can log a meaningful message.
export async function loadOakHomeInto(
  store: LoaderContext["store"],
  generateDigest: LoaderContext["generateDigest"],
  options: OakHomeLoaderOptions,
  projectRoot: string = process.cwd(),
  renderMarkdown?: LoaderContext["renderMarkdown"],
): Promise<{ loaded: boolean; relPath: string | null }> {
  const vaultRoot = isAbsolute(options.vault)
    ? options.vault
    : resolve(projectRoot, options.vault);
  const assetOutDir = options.assetOutDir
    ? isAbsolute(options.assetOutDir)
      ? options.assetOutDir
      : resolve(projectRoot, options.assetOutDir)
    : resolve(projectRoot, DEFAULT_ASSET_OUT_REL);
  const assetUrlPrefix = options.assetUrlPrefix ?? DEFAULT_ASSET_URL_PREFIX;

  const vault = await parseVault(options.vault);
  store.clear();
  const home = vault.homePub;
  if (!home) return { loaded: false, relPath: null };

  const processed = await processBodyAssets(
    home.body,
    home.filePath,
    vaultRoot,
    assetOutDir,
    assetUrlPrefix,
    {
      resolveSharpFrom: projectRoot,
      ...(options.optimizeImages !== undefined
        ? { optimize: options.optimizeImages }
        : {}),
      ...(options.imageWidths ? { widths: options.imageWidths } : {}),
      ...(options.imageQuality !== undefined
        ? { quality: options.imageQuality }
        : {}),
    },
  );

  const data: OakHomeData = {
    title: home.titlePlain,
    created: home.created,
    modified: home.modified,
  };
  const digest = generateDigest({ data, body: home.body });
  const rendered = renderMarkdown
    ? await renderMarkdown(processed.body)
    : undefined;
  store.set({
    id: HOME_ENTRY_ID,
    data: data as unknown as Record<string, unknown>,
    body: home.body,
    filePath: relativeFilePath(home.filePath, projectRoot),
    digest,
    ...(rendered ? { rendered } : {}),
  });
  return { loaded: true, relPath: home.relPath };
}

// Astro Content Layer loader for the published site's homepage —
// `<vault>/_home/pub.md`. Emits zero entries when the file is absent
// (the template falls back to its built-in page list); emits exactly
// one entry with id `pub` when present, mirroring the body asset
// pipeline pages go through so embeds and images resolve consistently.
//
// ```ts
// // src/content.config.ts
// export const collections = {
//   docs: defineCollection({ loader: oakLoader({ vault: "./vault" }) }),
//   home: defineCollection({ loader: oakHomeLoader({ vault: "./vault" }) }),
// };
// ```
export function oakHomeLoader(options: OakHomeLoaderOptions): Loader {
  return {
    name: "@oak/core/astro:oakHomeLoader",
    load: async (ctx: LoaderContext): Promise<void> => {
      const projectRoot = fileURLToPath(ctx.config.root);
      const reload = async (): Promise<void> => {
        const { loaded, relPath } = await loadOakHomeInto(
          ctx.store,
          ctx.generateDigest,
          options,
          projectRoot,
          ctx.renderMarkdown,
        );
        ctx.logger.info(
          loaded
            ? `oak: loaded homepage from ${relPath}`
            : "oak: no _home/pub.md (homepage)",
        );
      };

      await reload();

      if (ctx.watcher) {
        const vaultAbs = isAbsolute(options.vault)
          ? options.vault
          : resolve(projectRoot, options.vault);
        ctx.watcher.add(vaultAbs);
        let pending: NodeJS.Timeout | null = null;
        const onChange = (path: string): void => {
          if (!path.endsWith(".md")) return;
          if (pending) clearTimeout(pending);
          pending = setTimeout(() => {
            pending = null;
            void reload().catch((e) =>
              ctx.logger.error(`oak: reload failed: ${(e as Error).message}`),
            );
          }, 80);
        };
        ctx.watcher.on("add", onChange);
        ctx.watcher.on("change", onChange);
        ctx.watcher.on("unlink", onChange);
      }
    },
  };
}

// Options for `oakRedlinkLoader`.
export type OakRedlinkLoaderOptions = {
  // Vault path (same convention as oakLoader).
  vault: string;
  // Which visibilities contribute redlinks. Defaults to {public, unlisted}.
  visibilityFilter?: Visibility[];
};

// Entry shape stored in the redlinks collection. The slug is also
// the entry id, so routes can target `redlinks/<slug>`.
export type OakRedlinkData = RedlinkSummary;

// Astro Content Layer loader that materialises unresolved wiki link
// targets into a collection. Use alongside `oakLoader` so the
// publish-template can render one placeholder route per redlink:
//
// ```ts
// // src/content.config.ts
// export const collections = {
//   docs: defineCollection({ loader: oakLoader({ vault: "./vault" }) }),
//   redlinks: defineCollection({ loader: oakRedlinkLoader({ vault: "./vault" }) }),
// };
// ```
export function oakRedlinkLoader(options: OakRedlinkLoaderOptions): Loader {
  return {
    name: "@oak/core/astro:oakRedlinkLoader",
    load: async (ctx: LoaderContext): Promise<void> => {
      const projectRoot = fileURLToPath(ctx.config.root);
      const vaultRoot = isAbsolute(options.vault)
        ? options.vault
        : resolve(projectRoot, options.vault);

      const vault = await parseVault(vaultRoot);
      const graph = buildGraph(vault);
      const redlinks = collectRedlinks(vault, graph, {
        ...(options.visibilityFilter
          ? { visibilityFilter: options.visibilityFilter }
          : {}),
      });

      ctx.store.clear();
      for (const r of redlinks) {
        const digest = ctx.generateDigest({ data: r });
        ctx.store.set({
          id: r.slug,
          data: r as unknown as Record<string, unknown>,
          digest,
        });
      }
      ctx.logger.info(`oak: loaded ${redlinks.length} redlink(s)`);
    },
  };
}
