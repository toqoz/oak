# @oak/publish-template

Astro boilerplate that `oak publish` copies into a vault on first run.
Users are expected to customize this freely once it has been scaffolded
into their repo — oak will not touch it again.

## Status

Skeleton. The data layer integration (Content Layer loader and remark
plugins from `@oak/core`) is not yet implemented; this template
currently builds an empty Astro site. See `TODO` comments in:

- `astro.config.mjs`
- `src/content.config.ts`
- `src/pages/[...slug].astro`

## Usage (after `oak publish` lands)

```
oak publish
```

On first run, oak copies these files into the current directory, runs
the build, and pushes `dist/` to the `public` orphan branch.
