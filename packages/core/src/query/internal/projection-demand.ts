import type { QueryNode } from '../model.js';
import {
  ownLogicalProjectionDemand,
  relationDemandIdentity,
  type LogicalProjectionDemand,
  type RelationFieldDemand
} from '../projection-demand.js';
import { visitFullQuerySyntax } from './syntax-walk.js';

/**
 * Derives exact field needs only when a final select discards every unreferenced
 * input field. Complex row-shape and row-equality operators retain full reads.
 */
export const deriveProjectionDemand = (root: QueryNode): LogicalProjectionDemand | undefined => {
  if (root.kind !== 'select') return undefined;
  const nodes: QueryNode[] = [];
  const fields: { readonly alias: string; readonly name: string }[] = [];
  let containsSubquery = false;
  visitFullQuerySyntax(
    root,
    (node) => { nodes.push(node); },
    (expression) => {
      if (expression.kind === 'subquery') containsSubquery = true;
      else if (expression.kind === 'field') fields.push(expression);
    }
  );
  if (nodes.some((node) => node.kind === 'rename'
    || node.kind === 'omit'
    || node.kind === 'distinct'
    || node.kind === 'set'
    || node.kind === 'recursive'
    || node.kind === 'recursion-ref')
    || containsSubquery) return undefined;

  const relations = new Map<string, {
    readonly relation: RelationFieldDemand['relation'];
    readonly fields: Set<string>;
  }>();
  const relationsByAlias = new Map<string, Set<string>>();
  const derivedAliases = new Set<string>();
  for (const node of nodes) {
    if (node.kind === 'from') {
      const identity = relationDemandIdentity(node.relation);
      if (!relations.has(identity)) relations.set(identity, { relation: node.relation, fields: new Set() });
      const identities = relationsByAlias.get(node.alias) ?? new Set<string>();
      identities.add(identity);
      relationsByAlias.set(node.alias, identities);
    } else if (node.kind === 'values'
      || node.kind === 'select'
      || node.kind === 'aggregate'
      || node.kind === 'unnest'
      || node.kind === 'window') {
      derivedAliases.add(node.alias);
    }
  }
  if ([...derivedAliases].some((alias) => relationsByAlias.has(alias))
    || [...relationsByAlias.values()].some((identities) => identities.size !== 1)) return undefined;

  for (const field of fields) {
    for (const identity of relationsByAlias.get(field.alias) ?? []) {
      relations.get(identity)?.fields.add(field.name);
    }
  }
  return ownLogicalProjectionDemand(relations);
};
