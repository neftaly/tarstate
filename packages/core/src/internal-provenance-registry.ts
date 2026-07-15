/**
 * Realm-wide provenance for values that may cross separately bundled public
 * entry points. The protocol version changes only when the meaning of a seal
 * changes; compatible package copies intentionally share it.
 *
 * This is an accidental-forgery guard, not an authority boundary. Consumers
 * must still validate untrusted serialized input at their public parser.
 */
type ProvenanceRegistry = Readonly<{
  protocolVersion: 2;
  preparedExpressions: WeakSet<object>;
  preparedPlans: WeakSet<object>;
  preparedSchemas: WeakSet<object>;
  preparedRelations: WeakSet<object>;
  compiledMappings: WeakSet<object>;
  validatedLenses: WeakSet<object>;
  validatedLensSteps: WeakSet<object>;
}>;

const registryKey = Symbol.for('@tarstate/core/provenance/v2');
const realm = globalThis as typeof globalThis & { [key: symbol]: unknown };

const isRegistry = (value: unknown): value is ProvenanceRegistry => {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ProvenanceRegistry>;
  return candidate.protocolVersion === 2
    && candidate.preparedExpressions instanceof WeakSet
    && candidate.preparedPlans instanceof WeakSet
    && candidate.preparedSchemas instanceof WeakSet
    && candidate.preparedRelations instanceof WeakSet
    && candidate.compiledMappings instanceof WeakSet
    && candidate.validatedLenses instanceof WeakSet
    && candidate.validatedLensSteps instanceof WeakSet;
};

const createRegistry = (): ProvenanceRegistry => Object.freeze({
  protocolVersion: 2,
  preparedExpressions: new WeakSet<object>(),
  preparedPlans: new WeakSet<object>(),
  preparedSchemas: new WeakSet<object>(),
  preparedRelations: new WeakSet<object>(),
  compiledMappings: new WeakSet<object>(),
  validatedLenses: new WeakSet<object>(),
  validatedLensSteps: new WeakSet<object>()
});

const existing = realm[registryKey];
if (existing !== undefined && !isRegistry(existing)) {
  throw new TypeError('Incompatible Tarstate provenance registry in this realm');
}

export const provenanceRegistry: ProvenanceRegistry = existing ?? createRegistry();

if (existing === undefined) {
  Object.defineProperty(realm, registryKey, {
    value: provenanceRegistry,
    configurable: false,
    enumerable: false,
    writable: false
  });
}
