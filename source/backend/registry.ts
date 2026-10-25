import { mkdir, rm } from "node:fs/promises";
import { Store, identity, now, names, readJSON } from "./storage.ts";

export interface RegistryModel {
  id: string;
  context_length: number;
  pricing: Record<string, unknown>;
  supported_parameters?: string[];
  [key: string]: unknown;
}
export interface Catalog {
  schemaVersion: 1; id: string; provider: "openrouter"; source: string;
  fetchedAt: string; currency: "USD"; tokenPriceUnit: "per-token";
  models: RegistryModel[];
}
export function validateCatalog(value: unknown): RegistryModel[] {
  const data = value as { data?: RegistryModel[] };
  if (!Array.isArray(data?.data) || !data.data.length) throw new Error("Invalid registry");
  const ids = new Set<string>();
  for (const model of data.data) {
    if (typeof model.id !== "string" || !model.id || ids.has(model.id) ||
        !Number.isSafeInteger(model.context_length) || model.context_length < 1 ||
        !model.pricing || typeof model.pricing !== "object" || Array.isArray(model.pricing)) {
      throw new Error("Invalid registry entry");
    }
    for (const key of ["prompt", "completion", "input_cache_read", "input_cache_write"]) {
      const price = model.pricing[key];
      if (price !== undefined && (typeof price !== "string" || !/^(?:-1|\d+(?:\.\d+)?)$/.test(price))) {
        throw new Error("Invalid price");
      }
    }
    ids.add(model.id);
  }
  return data.data;
}

/** Single-flight hourly catalog service. It does not touch agent model choices. */
export class Registry {
  current: Catalog | null = null;
  private flight?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private failures = 0;
  readonly store: Store;
  readonly source: string;
  readonly fetcher: typeof fetch;
  constructor(store: Store, source: string, fetcher: typeof fetch = fetch) {
    this.store = store; this.source = source; this.fetcher = fetcher;
    // V1 has exactly one reviewed public source, not an arbitrary credential URL.
    if (source !== "https://openrouter.ai/api/v1/models") throw new Error("Unsupported registry source");
  }
  async start() {
    const files = (await names(this.store.path("registry/snapshots"))).filter((p) => p.endsWith(".json"));
    if (files.length) {
      this.current = await readJSON<Catalog>(this.store.path("registry/snapshots", files.at(-1)!));
      validateCatalog({ data: this.current.models });
      if (!Number.isFinite(Date.parse(this.current.fetchedAt))) throw new Error("Invalid registry date");
    }
    await this.refresh();
    this.schedule();
  }
  private schedule() {
    const delay = this.failures ? Math.min(60000 * 2 ** Math.min(this.failures - 1, 5), 3600000) : 3600000;
    this.timer = setTimeout(async () => {
      try { await this.refresh(); } catch { /* durable status failure is not healthy */ }
      this.schedule();
    }, delay);
    this.timer.unref();
  }
  async stop() { clearTimeout(this.timer); await this.flight; clearTimeout(this.timer); }
  refresh(): Promise<void> {
    if (!this.flight) this.flight = this.lockedRefresh().finally(() => { this.flight = undefined; });
    return this.flight;
  }
  private async lockedRefresh() {
    await mkdir(this.store.path("registry"), { recursive: true, mode: 0o700 });
    const lock = this.store.path("registry/.refresh-lock");
    try { await mkdir(lock, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        this.failures++;
        return; // Another process refreshes; never delete an uncertain stale lock.
      }
      throw error;
    }
    try { await this.perform(); }
    finally { await rm(lock, { recursive: true }); }
  }
  private async perform() {
    const attemptedAt = now();
    let failure: string | null = null;
    try {
      const response = await this.fetcher(this.source, { signal: AbortSignal.timeout(30000), redirect: "error" });
      if (!response.ok) throw new Error("Registry HTTP failure");
      const text = await response.text();
      if (text.length > 20 * 1024 * 1024) throw new Error("Registry too large");
      const body = JSON.parse(text);
      if (body.next || body.next_page || body.has_more || body.links?.next ||
          (body.total_count !== undefined && body.total_count !== body.data?.length)) throw new Error("Incomplete catalog");
      const snapshot: Catalog = { schemaVersion: 1, id: identity("catalog"), provider: "openrouter",
        source: this.source, fetchedAt: now(), currency: "USD", tokenPriceUnit: "per-token",
        models: validateCatalog(body) };
      await this.store.save(`registry/snapshots/${snapshot.fetchedAt.replace(/[:.]/g, "-")}-${snapshot.id}.json`, snapshot);
      this.current = snapshot;
      this.failures = 0;
    } catch {
      failure = "registry-refresh-failed";
      this.failures++;
    }
    const at = this.current?.fetchedAt ?? null;
    await this.store.replaceIndex("registry/status.json", {
      schemaVersion: 1, attemptedAt, lastSuccessAt: at, snapshotId: this.current?.id ?? null,
      nextAttemptAt: new Date(Date.now() + (this.failures ? Math.min(60000 * 2 ** Math.min(this.failures - 1, 5), 3600000) : 3600000)).toISOString(),
      error: failure,
    });
  }
  reference() {
    return { registrySnapshotId: this.current?.id ?? null,
      registryFreshness: !this.current ? "unavailable" :
        Date.now() - Date.parse(this.current.fetchedAt) >= 3600000 ? "stale" : "fresh" };
  }
}
