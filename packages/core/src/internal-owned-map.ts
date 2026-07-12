/**
 * A runtime-immutable ReadonlyMap view.
 *
 * Freezing a native Map does not disable its mutators, and a Map subclass can
 * still be changed with Map.prototype.set.call. Keeping the native Map in a
 * private slot makes the entries unreachable while preserving the public
 * ReadonlyMap contract and native iterators.
 */
class OwnedReadonlyMap<Key, Value> implements ReadonlyMap<Key, Value> {
  readonly #map: Map<Key, Value>;

  constructor(entries: Iterable<readonly [Key, Value]>) {
    this.#map = new Map(entries);
    Object.freeze(this);
  }

  get size(): number { return this.#map.size; }
  get [Symbol.toStringTag](): string { return 'Map'; }

  get(key: Key): Value | undefined { return this.#map.get(key); }
  has(key: Key): boolean { return this.#map.has(key); }
  entries(): MapIterator<[Key, Value]> { return this.#map.entries(); }
  keys(): MapIterator<Key> { return this.#map.keys(); }
  values(): MapIterator<Value> { return this.#map.values(); }
  [Symbol.iterator](): MapIterator<[Key, Value]> { return this.#map[Symbol.iterator](); }

  forEach(callbackfn: (value: Value, key: Key, map: ReadonlyMap<Key, Value>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.#map) callbackfn.call(thisArg, value, key, this);
  }
}

Object.freeze(OwnedReadonlyMap.prototype);

export const ownedReadonlyMap = <Key, Value>(entries: Iterable<readonly [Key, Value]>): ReadonlyMap<Key, Value> =>
  new OwnedReadonlyMap(entries);
