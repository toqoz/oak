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

Click on any row to focus + open it. `Esc` returns focus to Obsidian.

In the editor, when the cursor is on a `# TODO …` heading line, a
popover appears for attaching `SCHEDULED` / `DEADLINE`. `Esc` dismisses
it.

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

- `[#A]` — priority (configurable letters).
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
- Date range: `<2026-05-07 Thu>--<2026-05-09 Sat>`.
- Repeater: `+1d`, `++1w`, `.+2d` (every-N / catch-up / from-completion).
- Warning: `-2d` shifts the deadline pre-warning window.
- Units: `h` `d` `w` `m` `y`.

### Drawers

```
:PROPERTIES:
:CATEGORY: ops
:CUSTOM_KEY: value
:END:
```

`:PROPERTIES:` populates `entry.properties` (and `CATEGORY` overrides
the default category, which is the filename). `:LOGBOOK:` and any
other `:NAME: … :END:` drawer is parsed and skipped.

### Tag inheritance

Tags on an ancestor heading flow down to descendants. Frontmatter tags
and `#+FILETAGS:` are intentionally not supported — put a top-level
heading with the desired tags instead.

## DONE behavior (`d`)

- No repeater: the keyword is rewritten to the first entry of
  `doneKeywords`, and a `CLOSED:` line is inserted/merged into the
  planning line.
- Repeater present: keyword stays, `SCHEDULED` / `DEADLINE` are
  advanced according to the repeater kind, and a state-change line is
  appended under `:LOGBOOK:` (the drawer is created if missing).

Files are written atomically (temp file + rename).

## Find input syntax

The Find view's input dispatches on the first character:

- Starts with `+`, `-`, `@`, or `(` → tag/property match expression.
- Otherwise → case-insensitive regex over title + body.

Match grammar:

```
expr  := term ( ('+' | '-' | '&') term )*
term  := TAG | PROP '=' VALUE | PROP '<>' VALUE
```

`+` / `&` mean AND; `-` means AND NOT. Trailing `/STATE` filters by
TODO keyword (`/!STATE` for "not equal").

Examples:
- `+work-someday` — tagged `work` and not `someday`.
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

Edits to this file are picked up on the next vault refresh (`r`).
