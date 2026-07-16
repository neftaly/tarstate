import type { ValueDeclaration } from './builder.js';
import type { QueryNode } from './model.js';
import { prepareQuery } from './prepare.js';
import type { TypedAliases, TypedPreparedPlan, TypedQuery } from './authoring.js';
import type { ValueOfDeclaration } from '../schema-authoring.js';

/** Prepares a typed query while preserving its inferred row and parameter types. */
export const prepareTypedQuery = async <
  Aliases extends TypedAliases,
  Parameters extends Readonly<Record<string, ValueDeclaration>>,
  Row
>(
  query: TypedQuery<Aliases, Parameters, Row>,
  options: {
    readonly registryFingerprint: string;
    readonly authorityFingerprint: string;
    readonly datasetId: string;
  }
): Promise<TypedPreparedPlan<QueryNode, Row, { readonly [Name in keyof Parameters]: ValueOfDeclaration<Parameters[Name]> }>> =>
  prepareQuery({ root: query.root, ...options });
