import { canonicalizeJson, sha256Json, type ContentHash } from './artifacts.js';
import { createIssue, type CapabilityRef, type Issue, type ParseResult } from './issues.js';
import { comparePortableStrings } from './portable-order.js';
import type { JsonValue } from './value.js';

export type CapabilityClass = 'edit' | 'executor' | 'source' | 'function' | 'codec' | 'collation';

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

const refKey = (ref: CapabilityRef): string => ref.id + '\u0000' + ref.version + '\u0000' + ref.contractHash;

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
    const ref = await capabilityRefFor(declaration);
    const key = refKey(ref);
    const identityKey = declaration.id + '\u0000' + declaration.version;
    const conflicting = [...this.#declarations.entries()].find(([candidateKey, candidate]) => candidateKey.startsWith(identityKey + '\u0000') && canonicalizeJson(candidate as unknown as JsonValue) !== canonicalizeJson(declaration as unknown as JsonValue));
    if (conflicting !== undefined) return { success: false, issues: [createIssue({ code: 'capability.registry_conflict', retry: 'after_capability', details: { id: declaration.id, version: declaration.version } })] };
    this.#declarations.set(key, declaration);
    const cycle = this.#findCycle();
    if (cycle !== undefined) {
      this.#declarations.delete(key);
      return { success: false, issues: [createIssue({ code: 'capability.registry_cycle', retry: 'after_capability', details: { cycle } })] };
    }
    this.#revision += 1;
    return { success: true, value: ref, issues: [] };
  }

  registerImplementation(implementation: CapabilityImplementation): ParseResult<CapabilityImplementation> {
    const key = refKey(implementation.ref);
    if (!this.#declarations.has(key)) return { success: false, issues: [createIssue({ code: 'capability.missing', retry: 'after_capability', requiredCapabilities: [implementation.ref] })] };
    const previous = this.#implementations.get(key);
    if (previous !== undefined && previous.integrity !== implementation.integrity) return { success: false, issues: [createIssue({ code: 'capability.registry_conflict', retry: 'after_capability', requiredCapabilities: [implementation.ref] })] };
    this.#implementations.set(key, implementation);
    this.#revision += 1;
    return { success: true, value: implementation, issues: [] };
  }

  declaration(ref: CapabilityRef): CapabilityDeclaration | undefined { return this.#declarations.get(refKey(ref)); }
  implementation(ref: CapabilityRef): CapabilityImplementation | undefined { return this.#implementations.get(refKey(ref)); }

  satisfies(required: CapabilityRef): boolean {
    const target = refKey(required);
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
    return declaration?.implies.some((ref) => this.#implies(refKey(ref), target, visited)) ?? false;
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
        const cycle = visit(refKey(implied));
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
