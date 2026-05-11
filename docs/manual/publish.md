# Publishing

oak publishes a vault as a static site through an Astro app you own.
The CLI's job ends at "publishable snapshot + git branch"; the deploy
host runs the Astro build. This guide covers the end-to-end flow.

## Architecture in one paragraph

A vault is plain markdown. `oak pub init` creates an orphan git branch
called `oak/pub` and lays down a sibling worktree at
`<vault>/.git/oak/pub`, then scaffolds an Astro project (the
pub-template) into that worktree. Your notes branch stays clean.
`oak pub build` syncs the **publishable subset** of your vault (pages
whose visibility is `public` or `unlisted`, plus the assets they
reference) into `<worktree>/vault/`, commits the change, and
commits the change. Add `--push` to force-push `oak/pub` to the
remote so the deploy host can pick it up. The deploy host (Cloudflare
Pages, Vercel, Netlify, …) clones the branch and runs the Astro
build itself.

```
vault repo
├── main (notes only — your normal worktree)
│   └── content/, _assets/, …
└── oak/pub (orphan, force-pushed)
    └── checked out at .git/oak/pub/
        ├── src/                     Astro app
        ├── astro.config.mjs
        ├── package.json
        └── vault/                   publishable snapshot
            ├── public-page.md
            └── _assets/img.png

                           │
                           │ git push --force
                           ▼
                       origin/oak/pub ──► deploy host
                                              │ npm install
                                              │ npm run build
                                              ▼
                                            deployed site
```

## Why a publish worktree?

Keeping the Astro project off the notes branch buys two things:

- **Notes branch stays clean.** No `node_modules`, no `dist/`, no
  `.astro/`, no Astro source code mixed in with your markdown. You
  manage your notes branch on its own merits.
- **Private content never enters the publish branch.** The sync step
  works from an allow-list (publishable pages + their assets), not an
  exclusion list. Even a bug in some downstream filter can't leak a
  private page's bytes into deployed output, because they were never
  copied in the first place.

## Quick start

```bash
oak pub init                              # create branch + worktree + scaffold
cd .git/oak/pub
npm install                               # install Astro deps
npm run dev                               # local preview at http://localhost:4321
# Then, whenever you want to publish:
cd <vault>
oak pub build --push                      # refresh snapshot, commit, push
```

After the first push, point your host at the `oak/pub` branch and
let it run `npm run build`.

## CLI reference

### `oak pub init`

Creates the local `oak/pub` orphan branch (or reuses
`origin/oak/pub` if it already exists upstream) and adds a
worktree at `<vault>/.git/oak/pub`. If the branch is freshly
created, scaffolds the pub-template into the worktree.

Refuses if `<vault>/.git/oak/pub` already exists — remove it or
use it as-is.

In a development install (oak from source rather than from npm), the
scaffolded `package.json` has `workspace:*` references to oak. Init
detects this and rewrites them to `file:` paths so `npm install` can
find the local copy. The notice in the output makes this explicit
because `file:` paths are machine-specific and don't survive being
committed to git for someone else to clone.

### `oak pub build`

Syncs the publishable subset of the vault into the publish worktree's
`vault/` directory and commits the change. Pass `--push` to also
force-push `<remote>/<branch>`. The default is local-only because
pushing the publish branch triggers a deploy on most CD hosts —
opting in keeps that a deliberate action.

| Flag | Default | Effect |
|---|---|---|
| `--branch <name>` | `oak/pub` | Publish branch name |
| `--remote <name>` | `origin` | Remote to push to |
| `--push` | (off) | Push `<remote>/<branch>` after committing |

If the source vault's working tree is dirty, the commit subject is
tagged `publish: <source-sha> (dirty)` so the mismatch is visible in
`git log oak/pub`. The CLI does not refuse — there is no
checkpoint dance. If you want strict guarantees, commit before
publishing.

### `oak pub status`

Reports whether the publish branch and worktree exist locally.

### `oak pub`

With no subcommand: prints help.

## Visibility filter

`oak pub build` only writes a page into `vault/` if its frontmatter
`visibility` is in {`public`, `unlisted`}. Assets are included only
when referenced from one of those pages. Anything else stays out of
the publish branch.

This is the **source-side** defense. The Astro loader
(`@oak/core/astro` → `oakLoader`) also filters by visibility at load
time, but you should not rely on it alone: the file simply being
absent from the snapshot is a stronger guarantee than a filter
running over its contents.

If you want a different filter (say, public-only with no unlisted
pages), pass `visibilityFilter` to `pubBuild` from a script — the CLI
flag for this is not exposed yet.

## Template structure

After `oak pub init`, the publish worktree contains:

```
.git/oak/pub/
├── astro.config.mjs               wires remarkOakLinks + the vault path
├── package.json
├── tsconfig.json
├── src/
│   ├── content.config.ts          wires oakLoader for the docs collection
│   ├── layouts/Base.astro         page shell (head, header, footer)
│   ├── components/
│   │   ├── SiteHeader.astro       top nav (Index / Search)
│   │   ├── SiteFooter.astro
│   │   ├── PageList.astro         alphabetised page list w/ backlink count
│   │   └── Related.astro          backlinks + 2-hop card grid
│   ├── pages/
│   │   ├── index.astro            page list
│   │   ├── [...slug].astro        rendered page + related cards
│   │   ├── redlink/[slug].astro   placeholder page per unresolved [[target]]
│   │   ├── search.astro           client-side search UI
│   │   └── search.json.ts         corpus dump consumed by search.astro
│   ├── lib/
│   │   └── search.ts              search algorithm (pure functions)
│   └── styles/global.css          reset + typography + light/dark
└── vault/                         publishable vault snapshot (managed)
```

This template is intentionally small — read it end-to-end before
customizing. There is no theme system; CSS lives in scoped Astro
components and one global stylesheet. To restyle, edit those files.

## Customizing

### Layout / typography

`src/styles/global.css` for site-wide rules. `src/layouts/Base.astro`
for the head / shell structure. Component-scoped CSS lives in `<style>`
blocks inside each `.astro` file.

### Nav

`src/components/SiteHeader.astro`. The active-link styling looks at
`Astro.url.pathname` directly — change the link list, change the rule.

### Page rendering

`src/pages/[...slug].astro`. The body comes from `{Content}`
(Astro's render of the markdown collection entry). Backlinks and
2-hop neighbours come from `doc.data.inbound` / `doc.data.twoHop`
(populated by oakLoader). The `Related` component merges them into a
single deduplicated card grid, matching how the Obsidian plugin
renders its per-page "関連項目" footer.

### Redlinks

Unresolved wiki targets (`[[NotYetCreated]]`) are emitted by
`remarkOakLinks` as anchors pointing at `/redlink/<slug>/`. Each
redlink target gets a placeholder page (`src/pages/redlink/[slug].astro`)
listing the pages that reference it, so the reader can still navigate
the concept even when no real page exists yet.

The redlink set is materialised as a separate Astro content collection
via `oakRedlinkLoader` (see `src/content.config.ts`). The slug is
derived from the target string via `redlinkSlug(target)` from
`@oak/core` — keep this in sync if you change route shape.

### Search behavior

`src/lib/search.ts` is the algorithm. It splits the query on
whitespace (AND semantics across terms), matches case-insensitively
across title / aliases / headings / body, ranks title matches higher,
and surfaces matching body lines as snippets with `<mark>` highlights.
Editor-style keyboard nav (↑ / ↓ / Enter / Esc) is in
`src/pages/search.astro`.

## Images and other assets

oak handles vault assets at load time:

- Wiki embeds `![[diagram.png]]` and markdown images `![alt](./img.png)`
  are detected via `extractAssetRefs`.
- Each referenced file is resolved using oak's conventions (bare names
  → `_assets/`, paths with `/` → vault-rooted, `./` → page-relative,
  see `resolveAssetSource` in `@oak/core`).
- The resolved file is content-hashed (sha256, first 16 chars) and
  copied to `public/_oak/<hash>.<ext>` — same hash → one physical
  write, even across pages and reloads.
- Body URLs are rewritten to point at the hashed copies.

### Image optimization

If you set `optimizeImages: true` in `oakLoader` (the default in the
scaffolded template), png/jpg/jpeg files additionally go through
[`sharp`](https://sharp.pixelplumbing.com) to produce responsive WebP
variants. See `src/content.config.ts` for tunables (`optimizeImages`,
`imageWidths`, `imageQuality`).

## Deployment patterns

Because the publish branch is a real Astro project (not pre-built
HTML), the deploy target needs to be a host that runs the build. The
expected flow:

### Cloudflare Pages

1. Connect your repo.
2. Set the production branch to `oak/pub`.
3. Framework preset: Astro.
4. Build command: `npm run build`.
5. Build output directory: `dist`.

### Vercel

1. Connect your repo.
2. Set the production branch to `oak/pub`.
3. Vercel auto-detects Astro and runs `npm run build` → `dist/`.

### Netlify

1. Connect your repo.
2. Set the publish branch to `oak/pub`.
3. Build command: `npm run build`.
4. Publish directory: `dist`.

### GitHub Pages

GitHub Pages doesn't run arbitrary builds for free private repos. For
public repos, use a GitHub Actions workflow that watches the
`oak/pub` branch and runs `npm run build` + uploads `dist/` to
`gh-pages`. Add the workflow yourself; oak doesn't ship one.

### SSR / dynamic rendering

The publish branch is just an Astro project — change `output: "server"`
in `astro.config.mjs` and configure an adapter to deploy with full
SSR. The `vault/` snapshot is still your source for content; the
deploy host runs whatever Astro is configured to run.

## Troubleshooting

### `publish branch oak/pub does not exist`

Run `oak pub init` first. It creates the branch locally only; the
first `oak pub build` pushes it.

### `publish worktree not found at .git/oak/pub`

The worktree was removed but the branch still exists. Re-run
`oak pub init` to recreate it (the branch and any prior publish
history are preserved).

### `publish worktree already exists`

The directory `<vault>/.git/oak/pub` is already there. If it's a
valid worktree, just `cd` into it and keep working. If it's stale,
remove it with `git worktree remove --force .git/oak/pub` and
re-run init.

### A page I expected isn't on the site

Check the page's frontmatter `visibility`. Only `public` and
`unlisted` are sync'd. A page without `visibility` defaults to
`private` and is omitted.

### Sharp errors at build time

`sharp` is required for image optimization. On unusual platforms its
prebuilt binaries may be missing — `npm rebuild sharp` or set
`SHARP_FORCE_GLOBAL_LIBVIPS` per
[sharp's docs](https://sharp.pixelplumbing.com/install). To disable
optimization entirely, set `optimizeImages: false` in
`src/content.config.ts`.

### Edits to my vault don't show up in `npm run dev`

Dev mode reads from `.git/oak/pub/vault/`, which is only refreshed
by `oak pub build`. Re-run `oak pub build` (or just the sync portion
via a script) to refresh local dev. This is a known trade-off:
keeping vault and publish branches separate means no live link from
your notes editor to the dev server.
