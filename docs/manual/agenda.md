# Agenda

A port of emacs `org-agenda` to Obsidian. Scans the vault for org-style
TODO headings and timestamps and surfaces them in a single view.

## Opening

Run `Oak: Open agenda` from the command palette, or click the calendar
icon in any view's header.

## Keyboard shortcuts

The agenda view has its own focus scope. While it is focused:

| Key | Action |
| --- | --- |
| `j`, `↓`, `Ctrl-n` | Focus next item |
| `k`, `↑`, `Ctrl-p` | Focus previous item |
| `Enter` | Open the focused item at its source line |
| `d` | Mark focused entry DONE (or advance its repeater) |
| `r` | Force a vault re-scan |
| `Shift-R` | Refile focused entry (move heading + subtree elsewhere) |

Click on any row to focus + open it. `Esc` returns focus to Obsidian.

In the editor, when the cursor sits anywhere inside a `# TODO …`
heading's scope — the heading line itself or any of its body content,
including nested non-TODO subsections — a small calendar icon appears
in the left margin of the heading. Click it to open a popover below
the heading; the popover shows the current `SCHEDULED` and `DEADLINE`
values and lets you edit or clear each. Move the cursor out of the
scope, click the icon again, or press `Esc` to dismiss it.

## Recognized syntax

Headings are plain Markdown ATX (`#` through `######`). Everything else
— TODO keywords, priorities, tag blocks, planning lines, timestamps,
drawers — is lifted from org-mode. Fenced code blocks (`` ``` `` /
`~~~`) are inert.

### Headings

The leading word of the heading is parsed as a TODO keyword if it
appears in `todoKeywords` / `doneKeywords`.

```
## TODO [#A] Write the report :work:urgent:
```

- `[#A]` — priority. Letters between `priorities.highest` and
  `priorities.lowest` (inclusive) are recognized; out-of-range
  letters stay in the title as literal text. Sort comparison treats
  `A < B < C` (so `A` is highest). Unprioritized entries sort as if
  they had `priorities.default`.
- `:work:urgent:` — trailing tag block.

A heading is included in the agenda only if it has a TODO keyword, a
planning line, or an active body timestamp. Plain prose headings are
ignored.

### Planning lines

The line(s) directly below a heading (after blank lines) may carry:

```
SCHEDULED: <2026-05-07 Thu>  DEADLINE: <2026-05-14 Thu>  CLOSED: [2026-05-07 Thu 18:30]
```

A planning line must contain only these tokens — anything else demotes
it to body text.

### Timestamps

- Active: `<2026-05-07 Thu>` — appears in date buckets.
- Inactive: `[2026-05-07 Thu 18:30]` — never shown in agenda; used for
  `CLOSED` and logbook entries.
- With time: `<2026-05-07 Thu 10:00>` or range `<… 10:00-11:30>`.
- Date range: `<2026-05-07 Thu>--<2026-05-09 Sat>` (or
  `[…]--[…]` for inactive ranges, which the parser still recognizes
  but the agenda never displays).
- Repeater: `+1d`, `++1w`, `.+2d` (every-N / catch-up / from-completion).
- Warning: `-2d` shifts the deadline pre-warning window.
- Units: `h` `d` `w` `m` `y`.

### Drawers

```
:PROPERTIES:
:CATEGORY: ops
:ID: stable-handle-001
:CUSTOM_KEY: value
:END:
```

`:PROPERTIES:` populates `entry.properties` (and `CATEGORY` overrides
the default category, which is the filename). `:ID:` overrides the
auto-derived entry handle — set this when you have duplicate sibling
headings or want the handle to survive heading-text edits. `:LOGBOOK:`
and any other `:NAME: … :END:` drawer is parsed and skipped.

Without an explicit `:ID:`, the handle is derived from the file path
plus the heading hierarchy. Duplicate sibling headings are
auto-disambiguated by appending the heading line number.

### Tag inheritance

Tags on an ancestor heading flow down to descendants. Frontmatter tags
and `#+FILETAGS:` are intentionally not supported — put a top-level
heading with the desired tags instead.

## Refile (`Shift-R`)

`Shift-R` on the focused entry refiles the heading + subtree to a
user-picked destination. Refile is a separate feature with its own
docs — see [Refile](refile.md) for the full picker, peek pane, and
multi-section selection.

## DONE behavior (`d`)

- No repeater: the keyword is rewritten to the first entry of
  `doneKeywords`, and a `CLOSED:` line is inserted/merged into the
  planning line.
- Repeater present: keyword stays, `SCHEDULED` / `DEADLINE` are
  advanced according to the repeater kind, and a state-change line is
  prepended to `:LOGBOOK:` (the drawer is created if missing).

Files are written atomically (temp file + rename); symlinked files
are resolved to their target so the link itself isn't replaced.

## Find input syntax

Press `Enter` in the Find input to apply the query. The first
character chooses the dialect:

- Starts with `+`, `-`, `@`, `#`, or `%` → tag/property match
  expression.
- Otherwise → case-insensitive regex over title + body.

Match grammar:

```
expr  := term ( ('+' | '-' | '&') term )*
term  := TAG | PROP '=' VALUE | PROP '<>' VALUE
```

`+` / `&` mean AND; `-` means AND NOT. Tag names may contain `@`,
`#`, `%` (the same characters the parser accepts in `:tag:` blocks).
Trailing `/STATE` filters by TODO keyword (`/!STATE` for "not
equal"). Grouping parentheses are not supported.

Examples:
- `+work-someday` — tagged `work` and not `someday`.
- `@home` — tagged `@home`.
- `urgent+OWNER="alice"` — tag `urgent` and property `OWNER` equals `alice`.
- `project/NEXT` — TODO keyword must be `NEXT`.

## Configuration — `.oak/agenda.yml`

All keys are optional. Defaults shown.

```yaml
todoKeywords: [TODO, NEXT, WAITING]
doneKeywords: [DONE, CANCELLED]
defaultDeadlineWarningDays: 14
useTagInheritance: true
tagsExcludeFromInheritance: []
agendaFiles: null            # null = whole vault
agendaFilesExclude: []
weekStartsOn: 1              # 0 = Sun, 1 = Mon
priorities: { highest: A, lowest: C, default: B }
skipDeadlinePrewarningIfScheduled: pre-scheduled  # false | true | pre-scheduled
```

`agendaFiles` / `agendaFilesExclude` accept a list of paths relative
to the vault root. Each entry matches an exact file or a directory
prefix:

```yaml
agendaFiles: [projects, tasks.md]   # only these are scanned
agendaFilesExclude: [projects/archive, templates]
```

Globs (`*`, `**`) are not supported.

`priorities.default` is the priority used for sort comparison when an
entry has no explicit `[#X]` — set it to the same letter you reach
for most often so unprioritized items rank with their natural cohort.

Edits to this file are picked up on the next vault refresh (`r`).
