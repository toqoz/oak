// A tiny force-directed layout. ~50 lines, no dependencies.
//
// Algorithm (Fruchterman–Reingold-ish):
//   - Repulsion between every pair of nodes (∝ 1/d).
//   - Attraction along every edge (∝ d).
//   - Mild gravity toward the center keeps disconnected components
//     from drifting offscreen.
//   - Velocity is damped and clamped each tick so the simulation
//     converges instead of orbiting forever.
//
// Designed to settle in a few hundred iterations even on graphs of
// a few hundred nodes. For larger vaults you'd want a quadtree —
// not the scope here.

export type LayoutNode = {
  id: string;
  // Filled by `layout()`.
  x: number;
  y: number;
};

export type LayoutEdge = {
  from: string;
  to: string;
};

export type LayoutOptions = {
  width: number;
  height: number;
  iterations?: number;
  // Higher = nodes spread out more.
  k?: number;
};

export function layout(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  options: LayoutOptions,
): void {
  const { width, height } = options;
  const iterations = options.iterations ?? 250;
  const k = options.k ?? Math.sqrt((width * height) / Math.max(nodes.length, 1));
  const cx = width / 2;
  const cy = height / 2;

  const byId = new Map(nodes.map((n) => [n.id, n]));
  // Random initial placement around the centre.
  for (const n of nodes) {
    n.x = cx + (Math.random() - 0.5) * width * 0.5;
    n.y = cy + (Math.random() - 0.5) * height * 0.5;
  }

  const vx = new Map<string, number>();
  const vy = new Map<string, number>();

  for (let iter = 0; iter < iterations; iter++) {
    // Cooling factor: large early movements, small late ones.
    const t = (1 - iter / iterations) * (Math.min(width, height) / 10);

    for (const a of nodes) {
      let fx = 0;
      let fy = 0;

      // Repulsion against every other node.
      for (const b of nodes) {
        if (a === b) continue;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) {
          dx = (Math.random() - 0.5) * 0.1;
          dy = (Math.random() - 0.5) * 0.1;
          d2 = dx * dx + dy * dy;
        }
        const f = (k * k) / d2;
        fx += dx * f;
        fy += dy * f;
      }

      // Gentle pull to centre.
      fx += (cx - a.x) * 0.005;
      fy += (cy - a.y) * 0.005;

      vx.set(a.id, fx);
      vy.set(a.id, fy);
    }

    // Attractive forces along edges.
    for (const e of edges) {
      const a = byId.get(e.from);
      const b = byId.get(e.to);
      if (!a || !b) continue;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const f = (d * d) / k;
      const ux = (dx / d) * f;
      const uy = (dy / d) * f;
      vx.set(a.id, (vx.get(a.id) ?? 0) - ux);
      vy.set(a.id, (vy.get(a.id) ?? 0) - uy);
      vx.set(b.id, (vx.get(b.id) ?? 0) + ux);
      vy.set(b.id, (vy.get(b.id) ?? 0) + uy);
    }

    // Apply, clamped by the cooling factor.
    for (const n of nodes) {
      const dvx = vx.get(n.id) ?? 0;
      const dvy = vy.get(n.id) ?? 0;
      const d = Math.sqrt(dvx * dvx + dvy * dvy) || 1;
      const move = Math.min(d, t) / d;
      n.x += dvx * move;
      n.y += dvy * move;
      // Keep inside the viewBox with a margin.
      n.x = Math.max(20, Math.min(width - 20, n.x));
      n.y = Math.max(20, Math.min(height - 20, n.y));
    }
  }
}
