import type { APIRoute } from "astro";
import { getCollection } from "astro:content";

// Static endpoint: emit nodes + edges for the publishable subgraph.
// The /graph page uses this for client-side layout.
export const GET: APIRoute = async () => {
  const docs = await getCollection("docs");
  const ids = new Set(docs.map((d) => d.data.oakId));

  const nodes = docs.map((d) => ({
    id: d.data.oakId,
    title: d.data.title,
    slug: d.data.slug,
    weight: d.data.inbound.length,
  }));

  const edges: Array<{ from: string; to: string }> = [];
  for (const d of docs) {
    for (const out of d.data.outbound) {
      if (ids.has(out.id)) {
        edges.push({ from: d.data.oakId, to: out.id });
      }
    }
  }

  return new Response(JSON.stringify({ nodes, edges }), {
    headers: { "Content-Type": "application/json" },
  });
};
