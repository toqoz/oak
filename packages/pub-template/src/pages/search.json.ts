import type { APIRoute } from "astro";
import { getCollection } from "astro:content";
import type { SearchDoc } from "@oak/core";

// Static endpoint: emit @oak/core's SearchDoc[] so the /search page
// can run `searchDocs(corpus, query)` client-side with the same
// scoring rules the editor uses (single substring, title/alias/body,
// tier-based ranking). The body is the raw markdown source so authors
// can find their own annotations, even those that don't render —
// `[[wiki]]` syntax, code spans, etc.
export const GET: APIRoute = async () => {
  const docs = await getCollection("docs");
  const payload: SearchDoc[] = docs.map((d) => ({
    id: d.id,
    title: d.data.title,
    aliases: d.data.aliases,
    body: d.body ?? "",
    visibility: d.data.visibility,
    // `path` is the host-supplied locator threaded back through the
    // search component's onOpen callback. For the pub site that's the
    // slug — also what /search.astro uses to navigate.
    path: d.data.slug,
  }));
  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
  });
};
