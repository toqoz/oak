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
    SiteHeader.astro          top nav (Index / Search)
    SiteFooter.astro
    PageList.astro            alphabetised page list w/ backlink count
    Related.astro             backlinks + 2-hop card grid
  pages/
    index.astro               homepage (from _home/pub.md) or page list
    [...slug].astro           rendered page + related cards
    redlink/[slug].astro      placeholder page per unresolved [[target]]
    search.astro              client-side editor-style search UI
    search.json.ts            corpus dump consumed by search.astro
  lib/
    search.ts                 search algorithm (pure functions)
  content.config.ts           wires oakLoader / oakHomeLoader / oakRedlinkLoader
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

There is no theme system, no plugin API, no config DSL. Just code.

## Build

The publish worktree lives at `<vault>/.oak/pub` after
`oak pub init`. Run development and build commands from inside it:

```bash
cd <vault>/.oak/pub
npm install      # or pnpm / yarn
npm run dev      # local preview at http://localhost:4321
npm run build    # produces dist/
```

After committing template/source changes, run `oak pub build` from
the vault root to refresh the `vault/` snapshot and commit it on
the `oak/pub` branch. Pass `--push` to push so the deploy host
(Cloudflare Pages, Vercel,
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
