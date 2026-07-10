export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type ArtifactRef = {
  readonly id: string;
  readonly contentHash: `sha256:${string}`;
};

export type CapabilityRef = {
  readonly id: string;
  readonly version: string;
  readonly contractHash: `sha256:${string}`;
};

export type RelationUse = {
  readonly schemaView: ArtifactRef;
  readonly relationId: string;
};

export type ExtensionNode = {
  readonly kind: 'extension';
  readonly capability: CapabilityRef;
  readonly payload: JsonValue;
};

export type Expr =
  | { readonly kind: 'literal'; readonly value: JsonValue }
  | { readonly kind: 'parameter'; readonly name: string }
  | { readonly kind: 'field'; readonly alias: string; readonly name: string }
  | {
      readonly kind: 'compare';
      readonly op: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte';
      readonly left: Expr;
      readonly right: Expr;
    }
  | { readonly kind: 'boolean'; readonly op: 'and' | 'or'; readonly args: readonly Expr[] }
  | { readonly kind: 'boolean'; readonly op: 'not'; readonly arg: Expr }
  | { readonly kind: 'call'; readonly capability: CapabilityRef; readonly args: readonly Expr[] }
  | ExtensionNode;

export type AggregateExpr = {
  readonly kind: 'aggregate.count';
  readonly value?: Expr;
  readonly distinct?: boolean;
};

export type QueryNode =
  | { readonly kind: 'from'; readonly relation: RelationUse; readonly alias: string }
  | { readonly kind: 'where'; readonly input: QueryNode; readonly predicate: Expr }
  | {
      readonly kind: 'select';
      readonly input: QueryNode;
      readonly alias: string;
      readonly fields: Readonly<Record<string, Expr>>;
    }
  | {
      readonly kind: 'join';
      readonly join: 'inner' | 'anti';
      readonly left: QueryNode;
      readonly right: QueryNode;
      readonly on: Expr;
    }
  | {
      readonly kind: 'aggregate';
      readonly input: QueryNode;
      readonly alias: string;
      readonly groupBy: Readonly<Record<string, Expr>>;
      readonly measures: Readonly<Record<string, AggregateExpr>>;
    }
  | ExtensionNode;

export type BaseTarget = {
  readonly relation: RelationUse;
  readonly alias: string;
  readonly where?: Expr;
};

export type FieldEdit =
  | { readonly kind: 'edit.replace'; readonly value: Expr }
  | { readonly kind: 'edit.counter-increment'; readonly amount: Expr }
  | {
      readonly kind: 'edit.text-splice';
      readonly index: Expr;
      readonly deleteCount: Expr;
      readonly insert: Expr;
    }
  | {
      readonly kind: 'edit.conflict-resolve';
      readonly observed: readonly JsonValue[];
      readonly value: Expr;
    }
  | ExtensionNode;

export type Statement =
  | {
      readonly kind: 'statement.insert';
      readonly relation: RelationUse;
      readonly rows: readonly Readonly<Record<string, Expr>>[];
    }
  | {
      readonly kind: 'statement.update';
      readonly target: BaseTarget;
      readonly edits: Readonly<Record<string, FieldEdit>>;
    }
  | { readonly kind: 'statement.delete'; readonly target: BaseTarget }
  | {
      readonly kind: 'statement.rekey';
      readonly target: BaseTarget;
      readonly key: Readonly<Record<string, Expr>>;
      readonly references: 'source-local-declared' | 'reject-if-referenced';
      readonly requires: CapabilityRef;
    }
  | {
      readonly kind: 'statement.move';
      readonly target: BaseTarget;
      readonly parent: Expr;
      readonly position:
        | { readonly kind: 'beginning' }
        | { readonly kind: 'end' }
        | { readonly kind: 'before'; readonly anchor: Expr }
        | { readonly kind: 'after'; readonly anchor: Expr };
      readonly missingAnchor: 'reject' | 'beginning' | 'end';
      readonly requires: CapabilityRef;
    }
  | ExtensionNode;

export type Guard =
  | { readonly kind: 'guard.query'; readonly root: QueryNode; readonly expect: 'exists' | 'empty' }
  | {
      readonly kind: 'guard.affected-count';
      readonly statementIndex: number;
      readonly count: 'matched' | 'logicallyChanged' | 'inserted' | 'deleted';
      readonly op: 'eq' | 'gte' | 'lte';
      readonly value: number;
    }
  | ExtensionNode;

export type LensStep =
  | { readonly kind: 'lens.field'; readonly from: string; readonly to: string; readonly write: 'invertible' | 'read-only' }
  | { readonly kind: 'lens.default'; readonly to: string; readonly value: JsonValue; readonly write: 'preserve' }
  | { readonly kind: 'lens.hide'; readonly from: string; readonly write: 'preserve' }
  | {
      readonly kind: 'lens.value-map';
      readonly from: string;
      readonly to: string;
      readonly cases: readonly {
        readonly from: JsonValue;
        readonly to: JsonValue;
        readonly writeBack: 'to-from' | 'same-only' | 'reject';
      }[];
      readonly unmapped: 'reject';
    }
  | {
      readonly kind: 'lens.lookup';
      readonly from: string;
      readonly to: string;
      readonly through: RelationUse;
      readonly sourceFields: readonly string[];
      readonly resultFields: readonly string[];
      readonly onMissing: 'reject';
      readonly onAmbiguous: 'reject';
      readonly write: 'invertible' | 'read-only';
    }
  | ExtensionNode;

export type SchemaLensBody = {
  readonly from: ArtifactRef;
  readonly to: ArtifactRef;
  readonly relations: readonly {
    readonly fromRelationId: string;
    readonly toRelationId: string;
    readonly steps: readonly LensStep[];
  }[];
};

export type Issue = {
  readonly id: string;
  readonly code: string;
  readonly severity: 'info' | 'warning' | 'error';
  readonly phase: 'query' | 'plan' | 'constraint' | 'commit' | 'lifecycle';
  readonly sourceId?: string;
  readonly relationId?: string;
  readonly operationId?: string;
  readonly retry?: 'never' | 'after_input' | 'after_refresh' | 'query_outcome';
  readonly details?: JsonValue;
};

export const issue = (
  code: string,
  phase: Issue['phase'],
  details?: JsonValue,
  context: Pick<Issue, 'sourceId' | 'relationId' | 'operationId' | 'retry'> = {}
): Issue => ({
  id: code + ':' + canonicalJson(details ?? null),
  code,
  severity: 'error',
  phase,
  ...(details === undefined ? {} : { details }),
  ...context
});

export const canonicalJson = (value: JsonValue): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const record = value as Readonly<Record<string, JsonValue>>;
  return '{' + Object.keys(record).sort().map((key) => JSON.stringify(key) + ':' + canonicalJson(record[key] as JsonValue)).join(',') + '}';
};

export const sameJson = (left: JsonValue, right: JsonValue): boolean => canonicalJson(left) === canonicalJson(right);
