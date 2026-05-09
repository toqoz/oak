# Refile

Move a heading and everything beneath it to another location — emacs
`org-refile` ported to oak. Refile is a generic heading-manipulation
feature: it works on any heading, agenda-worthy or not, and is its
own thing rather than an agenda sub-feature. (See [Agenda](agenda.md)
for the inbox-processing workflow that uses refile heavily.)

## Triggering a refile

Three entrypoints, all opening the same fuzzy picker once a source
heading has been identified:

- From the agenda: focus an entry (`j`/`k` or click) and press
  `Shift-R`.
- From the editor: place the cursor inside any heading's subtree (the
  heading does not need to be a TODO, scheduled, or otherwise
  agenda-worthy heading — plain prose headings are refilable too) and
  run `Oak: Refile heading at cursor` from the command palette.
- From the editor with a selection: select across two or more headings
  (the selection only has to brush each subtree — clipping a body
  line of a section is enough to count it) and run the same command.
  Every "top-level" section in the selection — that is, sections
  whose parents are not also in the selection — is refiled to one
  user-picked destination, in document order. Refiling a parent
  carries its descendant headings along, so descendants don't double-
  up in the move list.

The picker lists every heading in the vault, prefixed by the file's
vault path. Each file also offers `(top of file)` to refile under the
file root.

## Heading levels at the destination

The picked target receives the source heading as a direct child:
heading levels in the moved subtree shift so the source heading lands
at `target.level + 1`. A refile that would push any sub-heading past
level 6 is refused; so is refiling a heading onto itself or into its
own subtree.

For "(top of file)" — where there is no parent heading to nest under
— the resulting level comes from `topOfFileLevel` (see Configuration
below), which defaults to `2` so the moved heading lands at oak's
own root level (`##`).

## Atomicity

Cross-file refiles write the destination first, then the source. If
the source write fails after a successful destination write, the
subtree exists in both files — recoverable by hand, never silently
lost. Each side uses the same mtime-CAS atomic write the DONE flow
uses, so a concurrent external edit surfaces as a conflict instead of
silently clobbering changes.

## Peek pane

After a cross-file refile, the destination opens in a horizontal split
below the source leaf, scrolls to the moved heading, and takes focus —
the user lands at the destination ready to inspect or edit. The source
pane fades to half opacity while the peek is focused so the peek reads
as the active surface. Standard tab and view-header navigation are
hidden in the peek (same treatment as the scratch buffer); a single ×
button on the trailing edge of the view-header detaches it.

Peek dismissal behaves like a transient inspection panel:

- Press `Esc` while the peek has focus to detach it.
- Move focus back to another main-pane leaf (e.g. click the source
  pane) and the peek detaches automatically. Sidebar focus changes
  do not dismiss it — clicking the file explorer leaves the peek
  alone.
- Esc inside an `<input>` / `<textarea>` (e.g. the editable title
  row) is left alone — the input owns that key for its own
  commit-or-cancel handling.

Same-file refiles skip the peek — the source view is already showing
the updated buffer.

## Configuration — `.oak/refile.yml`

All keys are optional. Defaults shown.

```yaml
topOfFileLevel: 2   # heading level for top-of-file refile (1..6)
```

`topOfFileLevel` is the heading level the source heading becomes when
refiled to "(top of file)". Defaults to `2` because oak's body
convention starts at `##`; users on the emacs `org-refile`
clamp-to-level-1 convention can set it to `1`.

Edits to this file are picked up on the next vault refresh (`r` in
the agenda view, or anything else that triggers a vault re-scan).
