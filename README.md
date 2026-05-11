# oak

A local-file-first knowledge graph.

The only source of truth is plain local Markdown files. Everything
else is derived, disposable, and rebuildable.

## Workspace layout

```
packages/
  core/              parsing, link resolution, graph, validation,
                     remark plugins, Astro Content Layer loader,
                     publish branch tooling
  cli/               `oak` command-line interface
  pub-template/      Astro boilerplate scaffolded by `oak pub init`
  obsidian-plugin/   Obsidian integration
```

## Subpath exports from `@oak/core`

| Import                  | What it gives you                                  |
|-------------------------|----------------------------------------------------|
| `@oak/core`             | data layer (parse, graph, queries, publish-branch) |
| `@oak/core/remark`      | `remarkOakLinks`, `remarkOakAssets`                |
| `@oak/core/astro`       | `oakLoader` (Astro Content Layer)                  |

## Publishing flow

The publish workspace lives on its own orphan git branch — your notes
branch stays clean. The Astro app you own builds the site; oak owns
the branch, the worktree, and the visibility filter.

```bash
oak pub init                # create the `oak/pub` orphan branch
                            # + a worktree at .git/oak-pub/
                            # + scaffold the Astro template into it
cd .git/oak-pub
npm install                 # one-time, in the publish worktree
npm run dev                 # local preview from the snapshot

# whenever you want to publish:
cd <vault>
oak pub build               # sync publishable pages + assets into
                            # the worktree's vault/, commit, push
```

`oak pub build` only sync's pages whose frontmatter visibility is
`public` or `unlisted`, plus the assets those pages reference. Private
content never reaches the publish branch — defense in depth on top of
the loader's visibility filter.

The deploy host (Cloudflare Pages, Vercel, Netlify, …) clones
`oak/pub` and runs `npm run build` itself.

## Documentation

- [docs/manual/publish.md](docs/manual/publish.md) — full publishing
  guide: CLI reference, template structure, customization, image
  optimization, deployment patterns, troubleshooting.
- [docs/manual/agenda.md](docs/manual/agenda.md) — Obsidian agenda view.

## Development

```bash
pnpm install
pnpm -r build
pnpm -r test
node packages/cli/dist/index.js <command>
```
