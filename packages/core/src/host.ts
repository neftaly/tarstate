import { CapabilityRegistry } from './registry.js';
import { comparePortableStrings } from './portable-order.js';

export type RuntimeLease<Runtime> = { readonly runtime: Runtime; readonly release: () => void };

type RuntimeEntry<Runtime> = {
  readonly identity: object;
  readonly runtime: Runtime;
  leases: number;
  closed: boolean;
  readonly close: () => void;
};

export class HostRuntimeRegistry {
  readonly capabilities: CapabilityRegistry;
  readonly #sourceRuntimes = new Map<string, RuntimeEntry<unknown>>();
  #closed = false;

  constructor(options: { readonly trustPolicyId: string }) {
    this.capabilities = new CapabilityRegistry(options.trustPolicyId);
  }

  acquire<Runtime>(options: {
    readonly sourceId: string;
    readonly identity: object;
    readonly create: () => { readonly runtime: Runtime; readonly close: () => void };
  }): RuntimeLease<Runtime> {
    if (this.#closed) throw new Error('Host runtime registry is closed');
    const existing = this.#sourceRuntimes.get(options.sourceId);
    if (existing !== undefined && existing.identity !== options.identity) throw new Error('A different live source identity is registered for ' + options.sourceId);
    const entry = existing ?? (() => {
      const created = options.create();
      const next: RuntimeEntry<Runtime> = { identity: options.identity, runtime: created.runtime, close: created.close, leases: 0, closed: false };
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
        let closeFailed = false;
        let closeError: unknown;
        try {
          if (!entry.closed) {
            entry.closed = true;
            entry.close();
          }
        } catch (error) {
          closeFailed = true;
          closeError = error;
        } finally {
          if (this.#sourceRuntimes.get(options.sourceId) === entry) this.#sourceRuntimes.delete(options.sourceId);
        }
        if (closeFailed) throw closeError;
      }
    };
  }

  activeSourceIds(): readonly string[] { return [...this.#sourceRuntimes.keys()].sort(comparePortableStrings); }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    let failed = false;
    let firstError: unknown;
    for (const entry of this.#sourceRuntimes.values()) {
      entry.closed = true;
      try { entry.close(); } catch (error) {
        if (!failed) firstError = error;
        failed = true;
      }
    }
    this.#sourceRuntimes.clear();
    if (failed) throw firstError;
  }
}
