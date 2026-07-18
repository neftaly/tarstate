import type { ContentHash } from '../canonical-json.js';
import type { DatabaseTransactionTransform } from '../database/transaction.js';
import type { Issue } from '../issues.js';
import type { WritableLogicalState } from '../logical-edit.js';
import { authorExactKeyedRelationDelta } from '../relation-delta-authoring.js';
import type { CapabilityRegistry } from '../registry.js';
import type { PreparedSchema } from '../schema.js';
import {
  sealTransaction,
  type WriteExpression,
  type WriteStatement
} from '../transaction.js';
import type { JsonValue } from '../value.js';
import type { PreparedAttachmentRelation } from './preparation.js';
import { ImmutableDatabaseTransactionSnapshot } from './transaction-snapshot.js';

type TransactionAuthoringPreparation = {
  readonly schema: PreparedSchema;
  readonly relations: ReadonlyMap<string, PreparedAttachmentRelation>;
};

/** Pure logical-state authoring core; lifecycle, replay, and publication stay outside. */
export const authorAttachmentStateTransition = async (input: {
  readonly schemaView: { readonly id: string; readonly contentHash: ContentHash };
  readonly preparation: TransactionAuthoringPreparation;
  readonly registry: CapabilityRegistry;
  readonly snapshotOwner: object;
  readonly before: WritableLogicalState;
  readonly projectionIssues: readonly Issue[];
  readonly transform: DatabaseTransactionTransform;
}) => {
  const statements: WriteStatement[] = [];
  const authoringIssues: Issue[] = [];
  if (!input.projectionIssues.some(({ severity }) => severity === 'error')) {
    const beforeByRelation = groupTransactionFields(input.before.rows);
    const snapshot = new ImmutableDatabaseTransactionSnapshot({
      owner: input.snapshotOwner,
      schemaView: input.schemaView,
      schema: input.preparation.schema,
      availableRelations: input.preparation.relations,
      registry: input.registry,
      rowsByRelation: beforeByRelation,
      changedRelationIds: emptyChangedRelationIds,
      generatedKeyInserts: emptyGeneratedKeyInserts,
      authoringIssues: emptyAuthoringIssues
    });
    const transformed = await input.transform(snapshot);
    if (!(transformed instanceof ImmutableDatabaseTransactionSnapshot)
      || !transformed.belongsTo(input.snapshotOwner)) {
      throw new TypeError('Attachment transaction transform must return a snapshot created by this service');
    }
    authoringIssues.push(...transformed.rejectionIssues());
    const afterByRelation = transformed.relationRows();
    for (const relationId of authoringIssues.length === 0
      ? transformed.changedRelations()
      : emptyChangedRelationIds) {
      const relation = input.preparation.relations.get(relationId);
      if (relation === undefined) {
        throw new TypeError(`Transaction relation ${JSON.stringify(relationId)} is unavailable`);
      }
      const authored = authorExactKeyedRelationDelta({
        relation: { relationId, schemaView: input.schemaView },
        keyFields: relation.keyFields,
        replaceableFields: relation.replaceableFields,
        before: {
          completeness: 'exact',
          rows: beforeByRelation.get(relationId) ?? emptyTransactionFields
        },
        after: {
          completeness: 'exact',
          rows: afterByRelation.get(relationId) ?? emptyTransactionFields
        }
      });
      if (!authored.success) authoringIssues.push(...authored.issues);
      else statements.push(...authored.value);
    }
    for (const insert of authoringIssues.length === 0
      ? transformed.generatedInserts()
      : emptyGeneratedKeyInserts) {
      statements.push({
        kind: 'statement.insert-generated-key',
        relation: { relationId: insert.relationId, schemaView: input.schemaView },
        token: insert.token,
        fields: literalFields(insert.fields)
      });
    }
  }
  const transaction = await sealTransaction({ body: {
    schemaView: input.schemaView,
    parameters: {},
    statements: authoringIssues.length === 0 ? statements : [],
    guards: [],
    requiredCapabilities: []
  } });
  return {
    transaction,
    issues: Object.freeze(authoringIssues)
  };
};

const emptyTransactionFields: readonly Readonly<Record<string, JsonValue>>[] = Object.freeze([]);
const emptyChangedRelationIds: ReadonlySet<string> = new Set<string>();
const emptyGeneratedKeyInserts = Object.freeze([]);
const emptyAuthoringIssues: readonly Issue[] = Object.freeze([]);

const literalFields = (
  fields: Readonly<Record<string, JsonValue>>
): Readonly<Record<string, WriteExpression>> => {
  const expressions: Record<string, WriteExpression> = {};
  for (const field of Object.keys(fields)) {
    expressions[field] = { kind: 'literal', value: fields[field] as JsonValue };
  }
  return expressions;
};

/** Groups one adopted logical state once before per-relation delta authoring. */
const groupTransactionFields = (
  rows: readonly { readonly relationId: string; readonly fields: Readonly<Record<string, JsonValue>> }[]
): ReadonlyMap<string, readonly Readonly<Record<string, JsonValue>>[]> => {
  const grouped = new Map<string, Readonly<Record<string, JsonValue>>[]>();
  for (const { relationId, fields } of rows) {
    const relationRows = grouped.get(relationId);
    if (relationRows === undefined) grouped.set(relationId, [fields]);
    else relationRows.push(fields);
  }
  for (const relationRows of grouped.values()) Object.freeze(relationRows);
  return grouped;
};
