import { canonicalizeJson, isContentHash, sha256Json, type ContentHash } from './artifacts.js';
import { capabilityRefKey, createIssue, type CapabilityRef, type Issue, type ParseResult } from './issues.js';
import { detachAndFreezeJsonValue } from './internal-owned-json.js';
import { comparePortableStrings } from './portable-order.js';
import type { JsonValue } from './value.js';

export type CapabilityClass = 'edit' | 'executor' | 'source' | 'function' | 'codec' | 'collation';
const capabilityClasses: readonly CapabilityClass[] = ['edit', 'executor', 'source', 'function', 'codec', 'collation'];

export type CapabilityDeclaration = {
  readonly kind: 'tarstate.capability-contract';
  readonly formatVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly class: CapabilityClass;
  readonly contract: JsonValue;
  readonly implies: readonly CapabilityRef[];
};

export type CapabilityImplementation = {
  readonly ref: CapabilityRef;
  readonly integrity: string;
  readonly implementation: unknown;
};

export const capabilityRefFor = async (declaration: CapabilityDeclaration): Promise<CapabilityRef> => ({
  id: declaration.id,
  version: declaration.version,
  contractHash: await sha256Json(declaration as unknown as JsonValue)
});

export class CapabilityRegistry {
  readonly #declarations = new Map<string, CapabilityDeclaration>();
  readonly #implementations = new Map<string, CapabilityImplementation>();
  readonly trustPolicyId: string;
  #revision = 0;

  constructor(trustPolicyId: string) { this.trustPolicyId = trustPolicyId; }

  get revision(): number { return this.#revision; }

  async registerDeclaration(declaration: CapabilityDeclaration): Promise<ParseResult<CapabilityRef>> {
    const detached = detachAndFreezeJsonValue(declaration);
    if (!detached.success) return detached;
    const parsed = parseCapabilityDeclaration(detached.value);
    if (!parsed.success) return parsed;
    const ownedDeclaration = parsed.value;
    const ref = Object.freeze(await capabilityRefFor(ownedDeclaration));
    const key = capabilityRefKey(ref);
    const conflicting = [...this.#declarations.values()].find((candidate) =>
      candidate.id === ownedDeclaration.id
      && candidate.version === ownedDeclaration.version
      && canonicalizeJson(candidate as unknown as JsonValue) !== canonicalizeJson(ownedDeclaration as unknown as JsonValue)
    );
    if (conflicting !== undefined) return { success: false, issues: [createIssue({ code: 'capability.registry_conflict', retry: 'after_capability', details: { id: ownedDeclaration.id, version: ownedDeclaration.version } })] };
    if (this.#declarations.has(key)) return { success: true, value: ref, issues: [] };
    this.#declarations.set(key, ownedDeclaration);
    const cycle = this.#findCycle();
    if (cycle !== undefined) {
      this.#declarations.delete(key);
      return { success: false, issues: [createIssue({ code: 'capability.registry_cycle', retry: 'after_capability', details: { cycle } })] };
    }
    this.#revision += 1;
    return { success: true, value: ref, issues: [] };
  }

  registerImplementation(implementation: CapabilityImplementation): ParseResult<CapabilityImplementation> {
    const detachedRef = detachAndFreezeJsonValue(implementation.ref);
    if (!detachedRef.success) return detachedRef;
    const ref = parseCapabilityRef(detachedRef.value);
    if (ref === undefined || typeof implementation.integrity !== 'string' || implementation.integrity.length === 0) return invalidCapability('implementation_shape');
    const ownedImplementation = Object.freeze({ ref, integrity: implementation.integrity, implementation: implementation.implementation });
    const key = capabilityRefKey(ref);
    if (!this.#declarations.has(key)) return { success: false, issues: [createIssue({ code: 'capability.missing', retry: 'after_capability', requiredCapabilities: [ref] })] };
    const previous = this.#implementations.get(key);
    if (previous !== undefined && previous.integrity !== ownedImplementation.integrity) return { success: false, issues: [createIssue({ code: 'capability.registry_conflict', retry: 'after_capability', requiredCapabilities: [ref] })] };
    if (previous !== undefined && previous.implementation !== ownedImplementation.implementation) return { success: false, issues: [createIssue({ code: 'capability.registry_conflict', retry: 'after_capability', requiredCapabilities: [ref], details: { reason: 'implementation_identity_changed' } })] };
    if (previous !== undefined) return { success: true, value: previous, issues: [] };
    this.#implementations.set(key, ownedImplementation);
    this.#revision += 1;
    return { success: true, value: ownedImplementation, issues: [] };
  }

  declaration(ref: CapabilityRef): CapabilityDeclaration | undefined { return this.#declarations.get(capabilityRefKey(ref)); }
  implementation(ref: CapabilityRef): CapabilityImplementation | undefined { return this.#implementations.get(capabilityRefKey(ref)); }

  satisfies(required: CapabilityRef): boolean {
    const target = capabilityRefKey(required);
    if (this.#implementations.has(target)) return true;
    for (const implemented of this.#implementations.keys()) if (this.#implies(implemented, target, new Set())) return true;
    return false;
  }

  missing(required: readonly CapabilityRef[]): readonly Issue[] {
    return required.filter((ref) => !this.satisfies(ref)).map((ref) => createIssue({ code: 'capability.missing', retry: 'after_capability', requiredCapabilities: [ref] }));
  }

  async fingerprint(resourceBudgets: JsonValue = {}): Promise<ContentHash> {
    const declarations = [...this.#declarations.entries()].sort(([left], [right]) => comparePortableStrings(left, right)).map(([key, declaration]) => ({ key, declaration }));
    const implementations = [...this.#implementations.entries()].sort(([left], [right]) => comparePortableStrings(left, right)).map(([key, implementation]) => ({ key, integrity: implementation.integrity }));
    return sha256Json({ trustPolicyId: this.trustPolicyId, declarations, implementations, resourceBudgets } as unknown as JsonValue);
  }

  #implies(from: string, target: string, visited: Set<string>): boolean {
    if (from === target) return true;
    if (visited.has(from)) return false;
    visited.add(from);
    const declaration = this.#declarations.get(from);
    return declaration?.implies.some((ref) => this.#implies(capabilityRefKey(ref), target, visited)) ?? false;
  }

  #findCycle(): readonly string[] | undefined {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const path: string[] = [];
    const visit = (key: string): readonly string[] | undefined => {
      if (visiting.has(key)) return [...path.slice(path.indexOf(key)), key];
      if (visited.has(key)) return undefined;
      visiting.add(key);
      path.push(key);
      for (const implied of this.#declarations.get(key)?.implies ?? []) {
        const cycle = visit(capabilityRefKey(implied));
        if (cycle !== undefined) return cycle;
      }
      path.pop();
      visiting.delete(key);
      visited.add(key);
      return undefined;
    };
    for (const key of this.#declarations.keys()) {
      const cycle = visit(key);
      if (cycle !== undefined) return cycle;
    }
    return undefined;
  }
}

const parseCapabilityDeclaration = (value: JsonValue): ParseResult<CapabilityDeclaration> => {
  if (!isRecord(value) || !hasExactKeys(value, ['kind', 'formatVersion', 'id', 'version', 'class', 'contract', 'implies'])) return invalidCapability('declaration_shape');
  if (value.kind !== 'tarstate.capability-contract' || value.formatVersion !== 1 || typeof value.id !== 'string' || value.id.length === 0 || typeof value.version !== 'string' || value.version.length === 0 || typeof value.class !== 'string' || !capabilityClasses.includes(value.class as CapabilityClass) || !Array.isArray(value.implies)) return invalidCapability('declaration_shape');
  const implies: CapabilityRef[] = [];
  const seen = new Set<string>();
  for (const candidate of value.implies) {
    const ref = parseCapabilityRef(candidate);
    if (ref === undefined || seen.has(capabilityRefKey(ref))) return invalidCapability(ref === undefined ? 'implication_shape' : 'duplicate_implication');
    seen.add(capabilityRefKey(ref));
    implies.push(ref);
  }
  return {
    success: true,
    value: Object.freeze({
      kind: 'tarstate.capability-contract',
      formatVersion: 1,
      id: value.id,
      version: value.version,
      class: value.class as CapabilityClass,
      contract: value.contract as JsonValue,
      implies: Object.freeze(implies)
    }),
    issues: []
  };
};

const parseCapabilityRef = (value: unknown): CapabilityRef | undefined => {
  if (!isRecord(value) || !hasExactKeys(value, ['id', 'version', 'contractHash'])) return undefined;
  if (typeof value.id !== 'string' || value.id.length === 0 || typeof value.version !== 'string' || value.version.length === 0 || !isContentHash(value.contractHash)) return undefined;
  return Object.freeze({ id: value.id, version: value.version, contractHash: value.contractHash });
};

const invalidCapability = <Value>(reason: string): ParseResult<Value> => ({
  success: false,
  issues: [createIssue({ code: 'artifact.invalid_envelope', retry: 'after_input', details: { artifact: 'capability', reason } })]
});

const hasExactKeys = (value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean => {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => value !== null && typeof value === 'object' && !Array.isArray(value);
