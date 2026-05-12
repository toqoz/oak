// Page id generation.
//
// Crockford's Base32 alphabet (https://www.crockford.com/base32.html)
// excludes I, L, O, U so glances at a frontmatter id are unambiguous.
// 12 random chars = 60 bits of entropy; collisions inside a single vault
// are negligible at any realistic page count, and `parseVault` already
// surfaces and rewrites duplicate ids if one ever slips through.
//
// Ids are emitted as three 4-char groups joined by `-` (e.g. `ABCD-EFGH-JKMN`)
// to make them easier to read, copy, and dictate. Crockford Base32 treats
// hyphens as ignorable separators, so the grouped form is canonical for
// us — every consumer stores and compares the dashed string as-is.

import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const GROUP_SIZE = 4;
const GROUP_COUNT = 3;

export function newId(): string {
  const totalChars = GROUP_SIZE * GROUP_COUNT;
  const bytes = randomBytes(totalChars);
  const groups: string[] = [];
  for (let g = 0; g < GROUP_COUNT; g++) {
    let group = "";
    for (let i = 0; i < GROUP_SIZE; i++) {
      group += ALPHABET[bytes[g * GROUP_SIZE + i]! & 31];
    }
    groups.push(group);
  }
  return groups.join("-");
}
