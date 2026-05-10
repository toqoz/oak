# @oak/publish-template

Astro boilerplate scaffolded into your vault by `oak pub init`. Once
copied, this code lives in **your** repo — edit it freely. There is
no upstream contract to honor; oak treats it as your own.

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
  styles/global.css           reset + typography + light/dark
content/                      your markdown vault (gitkeep'd by default)
astro.config.mjs              wires remarkOakLinks + the vault path
src/content.config.ts         wires oakLoader for the docs collection
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

```bash
npm install      # or pnpm / yarn
npm run dev      # local preview at http://localhost:4321
npm run build    # produces dist/
```

Then `oak pub build` from the same directory commits `dist/` onto the
`public` orphan branch and pushes.
