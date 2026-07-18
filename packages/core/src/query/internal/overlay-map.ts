const maxOverlayEntries = 256;

const materializeOverlay = <Value>(
  base: ReadonlyMap<string, Value>,
  overrides: ReadonlyMap<string, Value | undefined>
): Map<string, Value> => {
  const output = new Map(base);
  for (const [key, value] of overrides) {
    if (value === undefined) output.delete(key);
    else output.set(key, value);
  }
  return output;
};

/** Bounded persistent string map used by incremental indexes between compactions. */
export class OverlayMap<Value> implements ReadonlyMap<string, Value> {
  readonly #base: ReadonlyMap<string, Value>;
  readonly #overrides: ReadonlyMap<string, Value | undefined>;
  readonly compacted: boolean;

  constructor(
    base: ReadonlyMap<string, Value>,
    overrides: ReadonlyMap<string, Value | undefined>
  ) {
    if (base instanceof OverlayMap) {
      const prior = base as OverlayMap<Value>;
      const combined = new Map(prior.#overrides);
      for (const [key, value] of overrides) combined.set(key, value);
      if (combined.size >= maxOverlayEntries) {
        this.#base = materializeOverlay(prior.#base, combined);
        this.#overrides = new Map();
        this.compacted = true;
      } else {
        this.#base = prior.#base;
        this.#overrides = combined;
        this.compacted = false;
      }
    } else if (overrides.size >= maxOverlayEntries) {
      this.#base = materializeOverlay(base, overrides);
      this.#overrides = new Map();
      this.compacted = true;
    } else {
      this.#base = base;
      this.#overrides = overrides;
      this.compacted = false;
    }
  }

  get(key: string): Value | undefined {
    return this.#overrides.has(key) ? this.#overrides.get(key) : this.#base.get(key);
  }

  has(key: string): boolean { return this.get(key) !== undefined; }
  get size(): number { return this.#materialized().size; }
  entries(): MapIterator<[string, Value]> { return this.#materialized().entries(); }
  keys(): MapIterator<string> { return this.#materialized().keys(); }
  values(): MapIterator<Value> { return this.#materialized().values(); }
  forEach(
    callback: (value: Value, key: string, map: ReadonlyMap<string, Value>) => void,
    thisArg?: unknown
  ): void {
    this.#materialized().forEach((value, key) => callback.call(thisArg, value, key, this));
  }
  [Symbol.iterator](): MapIterator<[string, Value]> { return this.entries(); }

  #materialized(): Map<string, Value> {
    return materializeOverlay(this.#base, this.#overrides);
  }
}
