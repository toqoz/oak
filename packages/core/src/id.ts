// Page id generation.
//
// Crockford's Base32 alphabet (https://www.crockford.com/base32.html)
// excludes I, L, O, U so glances at a frontmatter id are unambiguous.
// 12 chars = 60 bits of entropy; collisions inside a single vault are
// negligible at any realistic page count, and `parseVault` already
// surfaces and rewrites duplicate ids if one ever slips through.

import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const DEFAULT_LENGTH = 12;

export function newId(length: number = DEFAULT_LENGTH): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += ALPHABET[bytes[i]! & 31];
  }
  return out;
}
