/** Recoverable issue found while reading or evaluating data. */
export type TarstateDiagnostic = {
  readonly code: string;
  readonly message: string;
  readonly relation?: string;
  readonly field?: string;
  readonly key?: string;
  readonly detail?: unknown;
};

type DiagnosticFallback = Pick<TarstateDiagnostic, 'code' | 'message' | 'relation' | 'field' | 'key'>;
type DiagnosticSource = {
  readonly diagnostics?: () => readonly TarstateDiagnostic[] | Promise<readonly TarstateDiagnostic[]>;
};

/** Return a canonical diagnostic object without changing its data. */
export function diagnostic(input: TarstateDiagnostic): TarstateDiagnostic {
  return { ...input };
}

/** Normalize thrown values, strings, and diagnostic-like values into diagnostics. */
export function normalizeDiagnostics(
  input: unknown,
  fallback: DiagnosticFallback
): readonly TarstateDiagnostic[] {
  const values = Array.isArray(input) ? input : [input];

  return values.map((value) => normalizeDiagnostic(value, fallback));
}

/** Collect diagnostics from sources, preserving failures as source diagnostics. */
export async function collectDiagnostics(
  ...sources: readonly DiagnosticSource[]
): Promise<readonly TarstateDiagnostic[]> {
  const output: TarstateDiagnostic[] = [];

  for (const source of sources) {
    if (source.diagnostics === undefined) {
      continue;
    }

    try {
      output.push(...await source.diagnostics());
    } catch (error) {
      output.push(...normalizeDiagnostics(error, {
        code: 'source_error',
        message: 'source diagnostics failed'
      }));
    }
  }

  return output;
}

function normalizeDiagnostic(value: unknown, fallback: DiagnosticFallback): TarstateDiagnostic {
  if (isDiagnostic(value)) {
    return diagnostic(value);
  }

  return {
    ...fallback,
    message: messageFor(value, fallback.message),
    detail: value
  };
}

function messageFor(value: unknown, fallback: string): string {
  if (value instanceof Error) {
    return value.message;
  }

  if (typeof value === 'string') {
    return value;
  }

  return fallback;
}

function isDiagnostic(input: unknown): input is TarstateDiagnostic {
  return typeof input === 'object' &&
    input !== null &&
    typeof (input as { readonly code?: unknown }).code === 'string' &&
    typeof (input as { readonly message?: unknown }).message === 'string';
}
