# Publishing

oak publishes a vault as a static site by handing off to an Astro app
you own. The CLI's job ends at "build artifact + git branch"; the app
controls the rest. This guide covers the end-to-end flow.

## Architecture in one paragraph

A vault is plain markdown. `oak pub init` creates an orphan git branch
called `public` and scaffolds an Astro project (the publish-template)
into your repo. You build that project (`npm run build`) → produces
`dist/`. `oak pub build` copies `dist/` onto the `public` branch as a
new commit and force-pushes it. From there, any host that watches a
git branch — Cloudflare Pages, Netlify, GitHub Pages, Vercel — picks
it up and deploys.

```
vault (markdown)
    │
    │ oakLoader (Astro Content Layer)
    ▼
content collection ──► remarkOakLinks ──► HTML + assets in dist/
                                              │
                                              │ oak pub build
                                              ▼
                                        public branch
                                              │
                                              ▼
                                        host CD pipeline
```

## Quick start

```bash
oak pub init                # create the public branch + scaffold Astro
npm install                 # in the scaffolded project
npm run build               # build dist/
oak pub build               # commit + push dist/ onto public
```

Then point your host at the `public` branch.

## CLI reference

### `oak pub init`

Idempotent. Creates a local `public` orphan branch (no push) and copies
the template files into the current directory. Existing files are
**skipped** — re-running won't clobber your edits.

In a development install (oak from source rather than from npm), the
scaffolded `package.json` has `workspace:*` references to oak. Init
detects this and rewrites them to `file:` paths so `npm install` can
find the local copy. The notice in the output makes this explicit
because `file:` paths are machine-specific and don't survive being
committed to git for someone else to clone.

### `oak pub build`

Pushes a build artifact onto the publish branch.

| Flag | Default | Effect |
|---|---|---|
| `--source <dir>` | `dist` | Directory whose contents become the new commit |
| `--branch <name>` | `public` | Publish branch name |
| `--remote <name>` | `origin` | Remote to push to |
| `--no-push` | (off) | Commit locally without pushing |
| `--no-checkpoint` | (off) | Refuse to publish if working tree is dirty |
| `--allow-dirty` | (off) | Publish dirty tree, mark commit `(dirty)` |

By default, if the working tree has uncommitted changes, oak takes a
`checkpoint: before publish` commit on the source branch first. This
guarantees that the source SHA embedded in the publish commit message
(`publish: <source-sha>`) actually corresponds to the content that was
built. With `--no-checkpoint`, oak refuses to publish a dirty tree;
with `--allow-dirty`, it proceeds and tags the commit subject so you
can see the mismatch in `git log public`.

The build runs inside a temporary git worktree pointing at the
publish branch. Your main checkout never moves, your index isn't
touched, and force-push always succeeds because the orphan branch has
no shared history to protect.

### `oak pub status`

Reports whether the publish branch exists locally.

### `oak pub`

With no subcommand: prints help.

## Template structure

After `oak pub init`, your repo gains:

```
astro.config.mjs              wires remarkOakLinks + the vault path
src/
  content.config.ts           wires oakLoader for the docs collection
  layouts/Base.astro          page shell (head, header, footer)
  components/
    SiteHeader.astro          top nav (Index / Search / Graph)
    SiteFooter.astro
    PageList.astro            alphabetised page list w/ backlink count
    Backlinks.astro           inbound-link section for a page
  pages/
    index.astro               page list
    [...slug].astro           rendered page + backlinks
    search.astro              client-side search UI
    search.json.ts            corpus dump consumed by search.astro
    graph.astro               force-directed graph view
    graph.json.ts             nodes + edges consumed by graph.astro
  lib/
    search.ts                 search algorithm (pure functions)
    force-layout.ts           tiny force-directed layout
  styles/global.css           reset + typography + light/dark
content/                      your markdown vault
package.json
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

`src/pages/[...slug].astro`. The body comes from
`{Content}` (Astro's render of the markdown collection entry).
Backlinks come from `doc.data.inbound` (populated by oakLoader).
Add fields to the rendered shell freely.

### Search behavior

`src/lib/search.ts` is the algorithm. It splits the query on whitespace
(AND semantics across terms), matches case-insensitively across title /
aliases / headings / body, ranks title matches higher, and surfaces
matching body lines as snippets with `<mark>` highlights. Editor-style
keyboard nav (↑ / ↓ / Enter / Esc) is in `src/pages/search.astro`.

To switch matching to substring, regex, or fuzzy: rewrite the loop in
`searchCorpus`. The corpus is just an array of plain objects — no
indexing structures to fight.

### Graph view

`src/lib/force-layout.ts` is a ~50-line Fruchterman–Reingold-ish
layout. `src/pages/graph.astro` consumes it: fetches `/graph.json`,
runs the layout client-side, draws SVG nodes/edges, click a node to
navigate. To add zoom/pan, hover labels, or filtering, edit
`graph.astro`.

## Images and other assets

oak handles vault assets at load time:

- Wiki embeds `![[diagram.png]]` and markdown images `![alt](./img.png)`
  are detected via `extractAssetRefs`.
- Each referenced file is resolved using oak's conventions (bare names
  → `_assets/`, paths with `/` → vault-rooted, `./` → page-relative,
  see `resolveAssetSource` in `@oak/core`).
- The resolved file is content-hashed (sha256, first 16 chars) and
  copied to `public/_oak/<hash>.<ext>` — same hash → one physical write,
  even across pages and reloads.
- Body URLs are rewritten to point at the hashed copies.

### Image optimization

If you set `optimizeImages: true` in `oakLoader` (the default in the
scaffolded template), png/jpg/jpeg files additionally go through
[`sharp`](https://sharp.pixelplumbing.com) to produce responsive WebP
variants. Each image emits as raw `<img srcset>`:

```html
<img alt="My cover"
     src="/_oak/<hash>-1200w.webp"
     srcset="/_oak/<hash>-400w.webp 400w,
             /_oak/<hash>-800w.webp 800w,
             /_oak/<hash>-1200w.webp 1200w"
     sizes="(max-width: 1200px) 100vw, 1200px"
     loading="lazy" decoding="async">
```

Tunables on `oakLoader`:

- `optimizeImages: boolean` (default false in core, true in the template)
- `imageWidths: number[]` (default `[400, 800]`; the original width is
  always added)
- `imageQuality: number` (default 80)

The original image is also copied as-is, so direct references (e.g.
from outside markdown, or a future RSS feed) still work.

Non-image assets (svg, pdf, mp4, etc.) are copied unchanged regardless
of `optimizeImages` — sharp doesn't transcode them.

`sharp` is a peer dependency of `@oak/core`. The scaffolded template
declares it directly because pnpm's strict mode hides Astro's
transitive copy from sibling packages. If you remove image
optimization, you can also remove sharp from your dependencies.

## Deployment patterns

Because the publish artifact is just a git branch, deployment is "any
host that knows how to read a branch". A few common shapes:

### Cloudflare Pages

1. Connect your repo.
2. Set the production branch to `public`.
3. Build command: empty (the branch is already built).
4. Build output: `/`.

### GitHub Pages

1. Repo settings → Pages → Source: "Deploy from a branch".
2. Branch: `public` / root.

### Netlify

Same as Cloudflare: set the publish branch to `public`, no build
command.

### Vercel

Set "Output Directory" to `/`, "Build Command" to `:` (no-op), and
configure the production branch as `public`.

### Cloudflare Workers / SSR hosts

The publish branch is static HTML + assets. If you want SSR / dynamic
rendering, switch the template's `astro.config.mjs` to a non-static
output and skip `oak pub build` entirely — deploy via the host's
native flow.

## Troubleshooting

### "publish branch `public` does not exist"

Run `oak pub init` first. The branch is created locally only; it gets
pushed to the remote on the first `oak pub build`.

### "build artifact directory `dist` not found"

You forgot to run `npm run build` before `oak pub build`. The CLI
deliberately doesn't trigger your build — it's your build runner's
concern, so CI matrices and one-off deploys both compose cleanly.

### Working tree is dirty error with `--no-checkpoint`

`--no-checkpoint` enforces a clean tree. Either commit your changes
first, drop the flag (oak will checkpoint for you), or pass
`--allow-dirty` to publish anyway with a `(dirty)` tag in the commit
subject.

### Sharp errors at build time

If image optimization throws, check that `sharp` is installed in your
template's `node_modules` (it should be in `package.json` deps). On
unusual platforms, sharp's prebuilt binaries may be missing —
`npm rebuild sharp` or set `SHARP_FORCE_GLOBAL_LIBVIPS` per
[sharp's docs](https://sharp.pixelplumbing.com/install).

To disable optimization entirely, set `optimizeImages: false` in
`src/content.config.ts`.

### Search index doesn't reflect a change

`oak pub init` doesn't watch — run `npm run dev` instead. The
oakLoader watcher re-syncs the content collection on `.md` saves and
Astro HMRs the affected pages.

### Stale assets in `public/_oak/`

oak doesn't currently delete old hashed assets; references that no
longer exist in any page leave their files behind. If this matters,
`rm -rf public/_oak && npm run build` is safe — they get regenerated.
