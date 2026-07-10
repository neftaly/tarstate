import { canonicalizeJson, issueCatalog, type Issue, type IssueDeclaration, type IssueRetry, type JsonValue, type ParseResult } from '@tarstate/core';

export const schemaToolsIssueDeclarations: readonly IssueDeclaration[] = [
  { code: 'schema_tools.artifact_kind', phase: 'parse', severity: 'error', retries: ['after_input'] },
  { code: 'schema_tools.database_description_hash_mismatch', phase: 'parse', severity: 'error', retries: ['after_input'] },
  { code: 'schema_tools.database_description_invalid', phase: 'parse', severity: 'error', retries: ['after_input'] },
  { code: 'schema_tools.database_description_unavailable', phase: 'resolve', severity: 'error', retries: ['after_authority', 'after_refresh'] },
  { code: 'schema_tools.issue_catalog_hash_mismatch', phase: 'parse', severity: 'error', retries: ['after_input'] },
  { code: 'schema_tools.issue_catalog_invalid', phase: 'parse', severity: 'error', retries: ['after_input'] }
];

const declarations = new Map([...issueCatalog, ...schemaToolsIssueDeclarations.map((declaration) => [declaration.code, declaration] as const)]);

export const schemaToolsIssue = (code: string, details: JsonValue, retry?: IssueRetry): Issue => {
  const declaration = declarations.get(code);
  if (declaration === undefined) throw new TypeError('Unknown schema-tools issue code: ' + code);
  const resolvedRetry = retry ?? declaration.retries[0];
  if (resolvedRetry !== undefined && !declaration.retries.includes(resolvedRetry)) throw new TypeError('Invalid retry for schema-tools issue code: ' + code);
  return { id: code + ':' + canonicalizeJson(details), code, phase: declaration.phase, severity: declaration.severity, ...(resolvedRetry === undefined ? {} : { retry: resolvedRetry }), details };
};

export const schemaToolsFailure = <Value = never>(code: string, details: JsonValue): ParseResult<Value> => ({ success: false, issues: [schemaToolsIssue(code, details)] });
