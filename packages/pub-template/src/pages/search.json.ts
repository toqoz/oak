import type { APIRoute } from "astro";
import { getCollection } from "astro:content";

// Static endpoint: emit a JSON dump of every page so the client-side
// search has the full corpus to match against. Each entry carries
// title + slug + aliases + raw markdown body (search is performed
// against the source so authors can find their own annotations,
// even those that don't render — `[[wiki]]` syntax, code spans, etc.).
export const GET: APIRoute = async () => {
  const docs = await getCollection("docs");
  const payload = docs.map((d) => ({
    id: d.id,
    title: d.data.title,
    slug: d.data.slug,
    aliases: d.data.aliases,
    body: d.body ?? "",
  }));
  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
  });
};
