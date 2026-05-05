// Centralised vault state for the plugin. Wraps @oak/core so the rest
// of the plugin never has to know about parseVault / buildGraph /
// validateVault directly.
//
// Per directive §13 the plugin must not duplicate logic — this class
// is *only* a cache + invalidation point around @oak/core.

import {
  buildGraph,
  parseVault,
  validateVault,
  type Graph,
  type Issue,
  type Vault,
} from "@oak/core";
import type { App } from "obsidian";

import { vaultRoot } from "./paths.js";

export type VaultSnapshot = {
  vault: Vault;
  graph: Graph;
  issues: Issue[];
  generatedAt: number;
};

type Listener = (snapshot: VaultSnapshot | null) => void;

export class VaultState {
  private snapshot: VaultSnapshot | null = null;
  private listeners = new Set<Listener>();
  private debounceHandle: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<VaultSnapshot> | null = null;
  private debounceMs: number;

  constructor(private app: App, opts: { debounceMs?: number } = {}) {
    this.debounceMs = opts.debounceMs ?? 500;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.snapshot);
    return () => {
      this.listeners.delete(fn);
    };
  }

  current(): VaultSnapshot | null {
    return this.snapshot;
  }

  async refresh(): Promise<VaultSnapshot> {
    if (this.inFlight) return this.inFlight;
    const root = vaultRoot(this.app);
    const work = (async () => {
      const vault = await parseVault(root);
      const graph = buildGraph(vault);
      const issues = validateVault(vault, graph);
      const snap: VaultSnapshot = {
        vault,
        graph,
        issues,
        generatedAt: Date.now(),
      };
      this.snapshot = snap;
      for (const fn of this.listeners) fn(snap);
      return snap;
    })();
    this.inFlight = work;
    try {
      return await work;
    } finally {
      this.inFlight = null;
    }
  }

  scheduleRefresh(): void {
    if (this.debounceHandle) clearTimeout(this.debounceHandle);
    this.debounceHandle = setTimeout(() => {
      this.debounceHandle = null;
      this.refresh().catch((err) => {
        console.error("oak: refresh failed", err);
      });
    }, this.debounceMs);
  }

  dispose(): void {
    if (this.debounceHandle) {
      clearTimeout(this.debounceHandle);
      this.debounceHandle = null;
    }
    this.listeners.clear();
    this.snapshot = null;
  }
}
