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
  publish-template/  Astro boilerplate scaffolded by `oak pub init`
  obsidian-plugin/   Obsidian integration
```

## Subpath exports from `@oak/core`

| Import                  | What it gives you                                  |
|-------------------------|----------------------------------------------------|
| `@oak/core`             | data layer (parse, graph, queries, publish-branch) |
| `@oak/core/remark`      | `remarkOakLinks`, `remarkOakAssets`                |
| `@oak/core/astro`       | `oakLoader` (Astro Content Layer)                  |

## Publishing flow

The static site lives on its own git branch. There's no HTML rendering
inside oak — that job belongs to a small Astro app you own.

```bash
oak pub init                # create the `public` orphan branch +
                            # scaffold the Astro template into ./
npm install                 # one-time, in the scaffolded project
npm run build               # build dist/
oak pub build               # commit dist/ onto `public`, force-push
```

`oak pub build`:

- auto-checkpoints a dirty working tree before reading HEAD, so the
  embedded source SHA always matches the published content
- uses a temp git worktree, so your main checkout never moves
- supports `--source <dir>` (default `dist`), `--branch <name>`
  (default `public`), `--no-push`, `--no-checkpoint`, `--allow-dirty`,
  `--remote <name>`

## Development

```bash
pnpm install
pnpm -r build
pnpm -r test
node packages/cli/dist/index.js <command>
```
