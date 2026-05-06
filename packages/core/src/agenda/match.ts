// Match expression DSL for the `m` (tag/property match) view.
//
// Grammar (subset of org's tags-and-properties match):
//
//   expr      := term ( ('+' | '-' | '&') term )*
//   term      := tag | propPredicate
//   tag       := IDENT
//   propPred  := IDENT ('=' | '<>') VALUE
//   IDENT     := [A-Za-z_][A-Za-z0-9_-]*
//   VALUE     := '"' [^"]* '"' | IDENT
//
// Semantics:
//   '+'/'&' = AND, '-' = AND NOT. The first term has an implicit '+'.
//   Property names are matched case-insensitively. Property values are
//   compared as strings.
//
// Optional trailing `/STATE` filter (e.g. `work+urgent/!NEXT`):
//   `/STATE` requires todoState === STATE
//   `/!STATE` requires todoState !== STATE (typo: actually `/STATE`
//   alone is "must be that state"; org's `/!` form means "any TODO
//   except DONE"; we keep the simpler `/STATE` and `/!STATE` forms).

import type { AgendaEntry } from "./types.js";

type Term =
  | { kind: "tag"; name: string; negate: boolean }
  | {
      kind: "prop";
      name: string;
      op: "=" | "<>";
      value: string;
      negate: boolean;
    };

export type MatchPredicate = (entry: AgendaEntry) => boolean;

// Identifiers do not include `-`, since `-` is reserved as the
// "exclude" connector between terms.
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

export function compileMatch(expression: string): MatchPredicate {
  let body = expression.trim();
  if (body.length === 0) return () => true;

  let stateFilter: { state: string; not: boolean } | null = null;
  const slash = body.lastIndexOf("/");
  if (slash !== -1 && /^\/!?[A-Za-z_][A-Za-z0-9_-]*$/.test(body.slice(slash))) {
    const tail = body.slice(slash + 1);
    if (tail.startsWith("!")) {
      stateFilter = { state: tail.slice(1), not: true };
    } else {
      stateFilter = { state: tail, not: false };
    }
    body = body.slice(0, slash);
  }

  const terms: Term[] = [];
  let i = 0;
  let negate = false;
  if (body[0] === "+" || body[0] === "&") i = 1;
  else if (body[0] === "-") {
    i = 1;
    negate = true;
  }

  while (i < body.length) {
    const idMatch = body.slice(i).match(IDENT_RE);
    if (!idMatch) {
      throw new Error(
        `match: expected identifier at position ${i} in \`${expression}\``,
      );
    }
    const name = idMatch[0];
    i += name.length;
    let term: Term;
    if (body[i] === "=" || (body[i] === "<" && body[i + 1] === ">")) {
      const op: "=" | "<>" = body[i] === "=" ? "=" : "<>";
      i += op.length;
      let value: string;
      if (body[i] === '"') {
        const close = body.indexOf('"', i + 1);
        if (close === -1) {
          throw new Error(`match: unterminated string at ${i}`);
        }
        value = body.slice(i + 1, close);
        i = close + 1;
      } else {
        const v = body.slice(i).match(IDENT_RE);
        if (!v) throw new Error(`match: expected value at ${i}`);
        value = v[0];
        i += value.length;
      }
      term = { kind: "prop", name, op, value, negate };
    } else {
      term = { kind: "tag", name, negate };
    }
    terms.push(term);

    // Connector for next term.
    while (i < body.length && body[i] === " ") i++;
    if (i >= body.length) break;
    const c = body[i];
    if (c === "+" || c === "&") {
      i++;
      negate = false;
    } else if (c === "-") {
      i++;
      negate = true;
    } else {
      throw new Error(`match: unexpected \`${c}\` at ${i}`);
    }
  }

  return (entry: AgendaEntry): boolean => {
    if (stateFilter) {
      const matchesState = entry.todoState === stateFilter.state;
      if (stateFilter.not && matchesState) return false;
      if (!stateFilter.not && !matchesState) return false;
    }
    for (const t of terms) {
      let hit: boolean;
      if (t.kind === "tag") {
        hit = entry.tags.includes(t.name);
      } else {
        const propVal = entry.properties[t.name.toUpperCase()];
        if (propVal === undefined) {
          hit = t.op === "<>";
        } else {
          hit = t.op === "=" ? propVal === t.value : propVal !== t.value;
        }
      }
      if (t.negate) hit = !hit;
      if (!hit) return false;
    }
    return true;
  };
}
