# Refile

Move a heading and everything beneath it to another location — emacs
`org-refile` ported to oak. Refile is a generic heading-manipulation
feature: it works on any heading, agenda-worthy or not, and is its
own thing rather than an agenda sub-feature. (See [Agenda](agenda.md)
for the inbox-processing workflow that uses refile heavily.)

## Triggering a refile

Three entrypoints, all opening the same target picker once a source
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

## Target picker

The target picker takes over the peek pane (a horizontal split below
the source) as a 2-column view: a filterable file list on the left
and a live preview of the selected file on the right.

Default mode is **file mode**:

- Type to filter the file list by vault-relative path.
- `↓` / `↑` (or `Ctrl-n` / `Ctrl-p`) move the selection.
- `Enter` refiles under the selected file's page title (its first
  heading — typically the `# Title` h1).
- `Shift-Enter` drills into the selected file's headings — the left
  pane flips to **section mode**.
- `Esc` cancels the picker and closes the peek pane.

In section mode:

- Type to filter the heading list by title chain.
- `Enter` refiles under the highlighted heading.
- `Esc` returns to file mode.

Files with no headings are omitted from the picker — refile always
lands under some heading.

## Heading levels at the destination

The picked target receives the source heading as a direct child:
heading levels in the moved subtree shift so the source heading lands
at `target.level + 1`. A refile that would push any sub-heading past
level 6 is refused; so is refiling a heading onto itself or into its
own subtree.

## Atomicity

Cross-file refiles write the destination first, then the source. If
the source write fails after a successful destination write, the
subtree exists in both files — recoverable by hand, never silently
lost. Each side uses the same mtime-CAS atomic write the DONE flow
uses, so a concurrent external edit surfaces as a conflict instead of
silently clobbering changes.

## Peek pane

The peek pane below the source leaf has two roles in a single hop:

1. **Picker**: the moment a refile is triggered, the picker view
   takes over the peek pane. The user picks a target there.
2. **Destination preview**: after a cross-file refile completes, the
   peek pane swaps to a markdown view of the destination, scrolled
   to the moved heading. The user lands there ready to inspect or
   edit.

The source pane fades to half opacity while the peek is focused so the
peek reads as the active surface. Standard tab and view-header
navigation are hidden in the peek (same treatment as the scratch
buffer).

Peek dismissal behaves like a transient inspection panel:

- Press `Esc` to detach it. While the picker is up, this also cancels
  the in-flight refile.
- Move focus back to a main-pane leaf and the peek detaches
  automatically once you've engaged with it. Sidebar focus changes do
  not dismiss it.

Same-file refiles auto-close the peek as soon as the move completes —
the source view is already showing the updated buffer.

Refiling again from inside the peek (a peek-to-peek hop) keeps the
"source = main, destination = peek" shape consistent: the moment the
new refile is triggered from the peek, the file currently in the peek
(the one you are refiling out of) is opened in the main slot it was
originally split from, and the peek pane becomes the picker for the
new destination. The file that previously occupied the main slot is
dropped from view but preserved in that leaf's tab history (← walks
back to it).
