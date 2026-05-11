# @oak/pub-template

Astro boilerplate scaffolded into the publish worktree by
`oak pub init`. Once scaffolded, this code lives on the `oak/pub`
orphan branch of **your** vault repo — edit it freely. There is no
upstream contract to honor; oak treats it as your own.

## What's in here

```
src/
  layouts/Base.astro          page shell (head, header, footer)
  components/
    SiteHeader.astro          top nav (Index / Search / Graph)
    SiteFooter.astro
    PageList.astro            alphabetised page list w/ backlink count
    Backlinks.astro           inbound-link section for a page
  pages/
    index.astro               page list
    [...slug].astro           rendered page + backlinks
    search.astro              client-side editor-style search UI
    search.json.ts            corpus dump consumed by search.astro
    graph.astro               force-directed graph view
    graph.json.ts             nodes + edges consumed by graph.astro
  lib/
    search.ts                 search algorithm (pure functions)
    force-layout.ts           tiny force-directed layout (no deps)
  content.config.ts           wires oakLoader for the docs collection
  styles/global.css           reset + typography + light/dark
vault/                        publishable vault snapshot (managed by oak pub build)
astro.config.mjs              wires remarkOakLinks + the vault path
```

## Customising

This template is meant to be small enough to read end-to-end and
modify directly:

- Layout / typography  → `src/styles/global.css`, `src/layouts/Base.astro`
- Nav links            → `src/components/SiteHeader.astro`
- Page rendering       → `src/pages/[...slug].astro`
- Search behavior      → `src/lib/search.ts`, `src/pages/search.astro`
- Graph layout         → `src/lib/force-layout.ts`, `src/pages/graph.astro`

There is no theme system, no plugin API, no config DSL. Just code.

## Build

The publish worktree lives at `<vault>/.git/oak-pub` after
`oak pub init`. Run development and build commands from inside it:

```bash
cd <vault>/.git/oak-pub
npm install      # or pnpm / yarn
npm run dev      # local preview at http://localhost:4321
npm run build    # produces dist/
```

After committing template/source changes, run `oak pub build` from
the vault root to refresh the `vault/` snapshot and push the
`oak/pub` branch. The deploy host (Cloudflare Pages, Vercel,
Netlify, …) then clones the branch and runs `npm run build`.

## The `vault/` snapshot

`oak pub build` copies the **publishable subset** of the vault into
`./vault` here:

- pages whose frontmatter visibility is `public` or `unlisted`
- assets those pages reference (resolved against oak's path
  conventions: `./relative`, `vault-rooted/`, `_assets/<bare>`)

Pages with `visibility: private` are never copied — defense in depth
on top of the loader's visibility filter.

## Image optimization

png/jpg/jpeg files referenced from vault pages get responsive WebP
variants by default. Each image is read by [sharp](https://sharp.pixelplumbing.com)
at load time, transcoded to WebP at multiple widths (defaults: 400,
800, plus the original), and emitted as `<img srcset>`. The original
file is also copied as-is.

Tunables on `oakLoader` in `src/content.config.ts`:

- `optimizeImages` — toggle; set to `false` to skip transcoding and
  emit plain markdown image syntax instead
- `imageWidths` — list of variant widths in pixels
- `imageQuality` — WebP quality 1–100

If you don't want optimization, also remove `sharp` from `package.json`
dependencies — it's only needed for transcoding.

For the full publishing flow, customization guide, and deployment
patterns, see [docs/manual/publish.md](../../docs/manual/publish.md).
