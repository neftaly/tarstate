export type TarstateDiagnosticSeverity = 'info' | 'warning' | 'error';
export type TarstateCoreDiagnosticCode =
  | 'diagnostic'
  | 'not_implemented'
  | 'query_invalid'
  | 'relation_invalid'
  | 'relation_missing'
  | 'field_invalid'
  | 'field_missing'
  | 'row_invalid'
  | 'required'
  | 'unique'
  | 'foreign_key'
  | 'check'
  | 'constraint_failed'
  | 'transaction_failed'
  | 'write_patch_invalid'
  | 'materialization_unsupported'
  | 'materialization_missing'
  | 'materialization_stale'
  | 'change_tracking_unsupported'
  | 'runtime_unsupported';
export type TarstateDiagnosticCode = TarstateCoreDiagnosticCode | (string & {});
export type TarstateDiagnosticMode = 'collect' | 'throw' | 'warn';
export type TarstateDiagnosticOptions = {
  readonly diagnosticMode?: TarstateDiagnosticMode;
};

export type TarstateDiagnostic = {
  readonly code: TarstateDiagnosticCode;
  readonly severity?: TarstateDiagnosticSeverity;
  readonly message: string;
  readonly relation?: string;
  readonly field?: string;
  readonly surface?: string;
  readonly detail?: unknown;
};

export function diagnostic(input: TarstateDiagnostic): TarstateDiagnostic {
  return input;
}

export function normalizeDiagnostics(
  values: unknown,
  fallback: TarstateDiagnostic
): readonly TarstateDiagnostic[] {
  const list = Array.isArray(values) ? values : [values];
  return list.map((value) => isDiagnostic(value)
    ? value
    : {
        ...fallback,
        message: value instanceof Error ? value.message : typeof value === 'string' ? value : fallback.message,
        detail: value
      });
}

export function collectDiagnostics(...diagnostics: readonly unknown[]): readonly TarstateDiagnostic[] {
  return diagnostics.flatMap((item) => normalizeDiagnostics(item, {
    code: 'diagnostic',
    severity: 'info',
    message: 'diagnostic'
  }));
}

function isDiagnostic(input: unknown): input is TarstateDiagnostic {
  return isRecord(input)
    && typeof input.code === 'string'
    && (input.severity === undefined || isDiagnosticSeverity(input.severity))
    && typeof input.message === 'string';
}

function isDiagnosticSeverity(input: unknown): input is TarstateDiagnosticSeverity {
  return input === 'info' || input === 'warning' || input === 'error';
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null;
}
