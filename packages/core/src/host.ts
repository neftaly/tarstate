import { CapabilityRegistry } from './registry.js';

export type RuntimeLease<Runtime> = { readonly runtime: Runtime; readonly release: () => void };

type RuntimeEntry<Runtime> = {
  readonly identity: object;
  readonly runtime: Runtime;
  leases: number;
  readonly close: () => void;
};

export class HostRuntimeRegistry {
  readonly capabilities: CapabilityRegistry;
  readonly #sourceRuntimes = new Map<string, RuntimeEntry<unknown>>();

  constructor(options: { readonly trustPolicyId: string }) {
    this.capabilities = new CapabilityRegistry(options.trustPolicyId);
  }

  acquire<Runtime>(options: {
    readonly sourceId: string;
    readonly identity: object;
    readonly create: () => { readonly runtime: Runtime; readonly close: () => void };
  }): RuntimeLease<Runtime> {
    const existing = this.#sourceRuntimes.get(options.sourceId);
    if (existing !== undefined && existing.identity !== options.identity) throw new Error('A different live source identity is registered for ' + options.sourceId);
    const entry = existing ?? (() => {
      const created = options.create();
      const next: RuntimeEntry<Runtime> = { identity: options.identity, runtime: created.runtime, close: created.close, leases: 0 };
      this.#sourceRuntimes.set(options.sourceId, next as RuntimeEntry<unknown>);
      return next as RuntimeEntry<unknown>;
    })();
    entry.leases += 1;
    let released = false;
    return {
      runtime: entry.runtime as Runtime,
      release: () => {
        if (released) return;
        released = true;
        entry.leases -= 1;
        if (entry.leases > 0) return;
        entry.close();
        if (this.#sourceRuntimes.get(options.sourceId) === entry) this.#sourceRuntimes.delete(options.sourceId);
      }
    };
  }

  activeSourceIds(): readonly string[] { return [...this.#sourceRuntimes.keys()].sort((left, right) => left.localeCompare(right)); }

  close(): void {
    for (const entry of this.#sourceRuntimes.values()) entry.close();
    this.#sourceRuntimes.clear();
  }
}
