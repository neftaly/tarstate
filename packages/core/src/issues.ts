export type IssuePhase =
  | 'resolve'
  | 'load'
  | 'parse'
  | 'query'
  | 'plan'
  | 'constraint'
  | 'commit'
  | 'governance'
  | 'lifecycle'
  | 'presence'
  | 'sync';

export type IssueRetry =
  | 'never'
  | 'after_input'
  | 'after_refresh'
  | 'after_capability'
  | 'after_authority'
  | 'query_outcome'
  | 'manual_repair';

export type IssueSeverity = 'info' | 'warning' | 'error';

export type CapabilityRef = {
  readonly id: string;
  readonly version: string;
  readonly contractHash: `sha256:${string}`;
};

export type Issue = {
  readonly id: string;
  readonly code: string;
  readonly severity: IssueSeverity;
  readonly phase: IssuePhase;
  readonly sourceId?: string;
  readonly relationId?: string;
  readonly key?: unknown;
  readonly path?: readonly unknown[];
  readonly operationId?: string;
  readonly requiredCapabilities?: readonly CapabilityRef[];
  readonly retry?: IssueRetry;
  readonly details?: unknown;
};

export type IssueDeclaration = {
  readonly code: string;
  readonly phase: IssuePhase;
  readonly severity: IssueSeverity;
  readonly retries: readonly IssueRetry[];
  readonly capabilityRelevant?: boolean;
};

const declarations = [
  ['artifact.budget_exceeded', 'parse', 'error', ['after_input']],
  ['artifact.cycle', 'parse', 'error', ['after_input']],
  ['artifact.dependency_ambiguous', 'resolve', 'error', ['after_input']],
  ['artifact.dependency_mismatch', 'parse', 'error', ['after_input']],
  ['artifact.duplicate_member', 'parse', 'error', ['after_input']],
  ['artifact.hash_mismatch', 'parse', 'error', ['after_input']],
  ['artifact.hostile_shape', 'parse', 'error', ['after_input']],
  ['artifact.invalid_envelope', 'parse', 'error', ['after_input']],
  ['artifact.invalid_hash', 'parse', 'error', ['after_input']],
  ['artifact.invalid_json', 'parse', 'error', ['after_input']],
  ['artifact.unsupported_value', 'parse', 'error', ['after_input']],
  ['capability.missing', 'resolve', 'error', ['after_capability']],
  ['capability.registry_conflict', 'governance', 'error', ['after_capability']],
  ['capability.registry_cycle', 'governance', 'error', ['after_capability']],
  ['query.capability_unavailable', 'query', 'error', ['after_capability']],
  ['query.parameter_invalid', 'query', 'error', ['after_input']],
  ['transaction.operation_id_ambiguous', 'commit', 'error', ['never']],
  ['transaction.parameter_missing', 'plan', 'error', ['after_input']]
] as const satisfies readonly (readonly [string, IssuePhase, IssueSeverity, readonly IssueRetry[]])[];

export const issueCatalog: ReadonlyMap<string, IssueDeclaration> = new Map(
  declarations.map(([code, phase, severity, retries]) => [code, {
    code,
    phase,
    severity,
    retries,
    ...(code.startsWith('capability.') || code.includes('capability_') ? { capabilityRelevant: true } : {})
  }])
);

export type IssueInput = Omit<Issue, 'id' | 'phase' | 'severity'> & {
  readonly code: string;
  readonly phase?: IssuePhase;
  readonly severity?: IssueSeverity;
};

export const createIssue = (input: IssueInput): Issue => {
  const declaration = issueCatalog.get(input.code);
  const phase = input.phase ?? declaration?.phase;
  const severity = input.severity ?? declaration?.severity;
  if (phase === undefined || severity === undefined) throw new Error('Unregistered issue code requires explicit phase and severity: ' + input.code);
  const identity = stableIssueIdentity({
    code: input.code,
    sourceId: input.sourceId,
    relationId: input.relationId,
    key: input.key,
    path: input.path,
    operationId: input.operationId,
    requiredCapabilities: input.requiredCapabilities,
    details: input.details
  });
  return {
    id: input.code + ':' + identity,
    code: input.code,
    phase,
    severity,
    ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
    ...(input.relationId === undefined ? {} : { relationId: input.relationId }),
    ...(input.key === undefined ? {} : { key: input.key }),
    ...(input.path === undefined ? {} : { path: input.path }),
    ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
    ...(input.requiredCapabilities === undefined ? {} : { requiredCapabilities: input.requiredCapabilities }),
    ...(input.retry === undefined ? {} : { retry: input.retry }),
    ...(input.details === undefined ? {} : { details: input.details })
  };
};

const stableIssueIdentity = (input: Record<string, unknown>): string => {
  const entries = Object.entries(input).filter(([, value]) => value !== undefined).sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(Object.fromEntries(entries), (_key, value: unknown) => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
    }
    return value;
  });
};

export type ParseResult<Value> =
  | { readonly success: true; readonly value: Value; readonly issues: readonly Issue[] }
  | { readonly success: false; readonly issues: readonly Issue[] };

export class TarstateParseError extends Error {
  readonly issues: readonly Issue[];

  constructor(issues: readonly Issue[]) {
    super(issues.map((issue) => issue.code).join(', '));
    this.name = 'TarstateParseError';
    this.issues = issues;
  }
}
