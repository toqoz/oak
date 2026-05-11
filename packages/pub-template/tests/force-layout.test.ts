import { describe, expect, it } from "vitest";
import { layout, type LayoutNode } from "../src/lib/force-layout.ts";

function makeNodes(ids: string[]): LayoutNode[] {
  return ids.map((id) => ({ id, x: 0, y: 0 }));
}

describe("layout", () => {
  it("places every node within the viewBox margins", () => {
    const nodes = makeNodes(["a", "b", "c", "d", "e"]);
    layout(nodes, [], { width: 400, height: 300, iterations: 50 });
    for (const n of nodes) {
      expect(n.x).toBeGreaterThanOrEqual(20);
      expect(n.x).toBeLessThanOrEqual(380);
      expect(n.y).toBeGreaterThanOrEqual(20);
      expect(n.y).toBeLessThanOrEqual(280);
    }
  });

  it("separates nodes that have no edges", () => {
    // With pure repulsion + centre gravity, two nodes should not pile
    // up on top of each other.
    const nodes = makeNodes(["a", "b"]);
    layout(nodes, [], { width: 400, height: 300, iterations: 200 });
    const dx = nodes[0]!.x - nodes[1]!.x;
    const dy = nodes[0]!.y - nodes[1]!.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    expect(d).toBeGreaterThan(20);
  });

  it("brings edge-connected nodes closer than disconnected ones", () => {
    // Two pairs: (a-b) connected, (c-d) connected, no inter-pair edge.
    // Each pair should end up closer to its partner than to the other
    // pair on average.
    const nodes = makeNodes(["a", "b", "c", "d"]);
    const edges = [
      { from: "a", to: "b" },
      { from: "c", to: "d" },
    ];
    layout(nodes, edges, { width: 600, height: 600, iterations: 400 });

    const byId = new Map(nodes.map((n) => [n.id, n]));
    const dist = (p: string, q: string): number => {
      const a = byId.get(p)!;
      const b = byId.get(q)!;
      return Math.hypot(a.x - b.x, a.y - b.y);
    };

    expect(dist("a", "b")).toBeLessThan(dist("a", "c"));
    expect(dist("c", "d")).toBeLessThan(dist("c", "a"));
  });

  it("handles zero-node and zero-edge inputs without throwing", () => {
    expect(() =>
      layout([], [], { width: 100, height: 100, iterations: 10 }),
    ).not.toThrow();
    const nodes = makeNodes(["solo"]);
    expect(() =>
      layout(nodes, [], { width: 100, height: 100, iterations: 10 }),
    ).not.toThrow();
  });

  it("ignores edges referencing missing nodes", () => {
    const nodes = makeNodes(["a", "b"]);
    const edges = [
      { from: "a", to: "b" },
      { from: "ghost", to: "a" },
    ];
    expect(() =>
      layout(nodes, edges, { width: 200, height: 200, iterations: 50 }),
    ).not.toThrow();
  });
});
