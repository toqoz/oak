# oak

A local-file-first knowledge graph.

The only source of truth is plain local Markdown files. Everything else is derived, disposable, and rebuildable.

## Status

Phase 1 (core + CLI). See `directive` for the full roadmap.

## Workspace layout

```
packages/
  core/   parsing, link resolution, graph, validation
  cli/    `oak` command-line interface
```

## Development

```bash
pnpm install
pnpm -r build
pnpm -r test
node packages/cli/dist/index.js index <vault>
```
