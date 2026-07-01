/** Recoverable issue found while reading or evaluating data. */
export type TarstateDiagnostic = {
  readonly code:
    | 'duplicate_key'
    | 'invalid_row'
    | 'missing_ref'
    | 'unreadable_ref'
    | 'source_error'
    | 'unsupported_expression'
    | 'unsupported_lookup';
  readonly message: string;
  readonly relation?: string;
  readonly field?: string;
  readonly key?: string;
  readonly detail?: unknown;
};
