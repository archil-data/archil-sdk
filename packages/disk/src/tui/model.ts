import type { Sandbox } from "../sandbox.js";

export type SandboxSort = "lastActive" | "name" | "status";

export interface SandboxService {
  list(): Promise<Sandbox[]>;
}

export interface SandboxModelSnapshot {
  sandboxes: readonly Sandbox[];
  visibleSandboxes: readonly Sandbox[];
  selected?: Sandbox;
  selectedId?: string;
  filter: string;
  sort: SandboxSort;
  loading: boolean;
  error?: string;
  lastRefresh?: Date;
  busyIds: ReadonlySet<string>;
}

export class SandboxModel {
  private sandboxes: Sandbox[] = [];
  private selectedId?: string;
  private filter = "";
  private sort: SandboxSort = "lastActive";
  private loading = false;
  private error?: string;
  private lastRefresh?: Date;
  private busyIds = new Set<string>();
  private refreshPromise?: Promise<void>;
  private pollTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private generation = 0;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly service: SandboxService,
    private readonly pollIntervalMs = 2_500,
  ) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): SandboxModelSnapshot {
    const visibleSandboxes = this.filteredAndSorted();
    return {
      sandboxes: this.sandboxes,
      visibleSandboxes,
      selected: visibleSandboxes.find((sandbox) => sandbox.id === this.selectedId),
      selectedId: this.selectedId,
      filter: this.filter,
      sort: this.sort,
      loading: this.loading,
      error: this.error,
      lastRefresh: this.lastRefresh,
      busyIds: this.busyIds,
    };
  }

  async refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    const generation = this.generation;
    this.loading = true;
    this.emit();
    this.refreshPromise = (async () => {
      try {
        const sandboxes = await this.service.list();
        if (this.stopped || generation !== this.generation) return;
        this.sandboxes = sandboxes;
        this.error = undefined;
        this.lastRefresh = new Date();
        const visible = this.filteredAndSorted();
        if (!visible.some((sandbox) => sandbox.id === this.selectedId)) {
          this.selectedId = visible[0]?.id;
        }
      } catch (error) {
        if (!this.stopped && generation === this.generation) {
          this.error = error instanceof Error ? error.message : String(error);
        }
      } finally {
        if (generation === this.generation) {
          this.loading = false;
          this.refreshPromise = undefined;
          this.emit();
        }
      }
    })();
    return this.refreshPromise;
  }

  startPolling(): void {
    this.stopped = false;
    this.schedulePoll(0);
  }

  stopPolling(): void {
    this.stopped = true;
    this.generation++;
    this.refreshPromise = undefined;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
  }

  restartPolling(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.stopped = false;
    this.schedulePoll(this.pollIntervalMs);
  }

  setFilter(filter: string): void {
    this.filter = filter;
    const visible = this.filteredAndSorted();
    if (!visible.some((sandbox) => sandbox.id === this.selectedId)) this.selectedId = visible[0]?.id;
    this.emit();
  }

  setSort(sort: SandboxSort): void {
    this.sort = sort;
    this.emit();
  }

  selectOffset(offset: number): void {
    const visible = this.filteredAndSorted();
    if (visible.length === 0) return;
    const index = Math.max(0, visible.findIndex((sandbox) => sandbox.id === this.selectedId));
    this.selectedId = visible[Math.max(0, Math.min(visible.length - 1, index + offset))]?.id;
    this.emit();
  }

  selectFirst(): void {
    this.selectedId = this.filteredAndSorted()[0]?.id;
    this.emit();
  }

  selectLast(): void {
    this.selectedId = this.filteredAndSorted().at(-1)?.id;
    this.emit();
  }

  setBusy(id: string, busy: boolean): void {
    if (busy) this.busyIds.add(id);
    else this.busyIds.delete(id);
    this.emit();
  }

  private filteredAndSorted(): Sandbox[] {
    const terms = this.filter.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return this.sandboxes
      .filter((sandbox) => {
        const haystack = `${sandbox.name} ${sandbox.id} ${sandbox.status} ${sandbox.baseImage}`.toLocaleLowerCase();
        return terms.every((term) => haystack.includes(term));
      })
      .sort((a, b) => {
        if (this.sort === "name") return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
        if (this.sort === "status") return a.status.localeCompare(b.status) || a.name.localeCompare(b.name);
        return b.lastActiveAt.getTime() - a.lastActiveAt.getTime() || a.id.localeCompare(b.id);
      });
  }

  private schedulePoll(delay: number): void {
    if (this.stopped) return;
    this.pollTimer = setTimeout(async () => {
      await this.refresh();
      this.schedulePoll(this.pollIntervalMs);
    }, delay);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
