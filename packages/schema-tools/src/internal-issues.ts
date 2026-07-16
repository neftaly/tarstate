import { canonicalizeJson, issueCatalog, type Issue, type IssueDeclaration, type IssueRetry, type JsonValue, type ParseResult } from '@tarstate/core';

const declaration = (
  code: string,
  phase: IssueDeclaration['phase'],
  retries: IssueDeclaration['retries']
): IssueDeclaration => Object.freeze({ code, phase, severity: 'error', retries: Object.freeze([...retries]) });

export const schemaToolsIssueDeclarations: readonly IssueDeclaration[] = Object.freeze([
  declaration('schema_tools.artifact_kind', 'parse', ['after_input']),
  declaration('schema_tools.database_description_hash_mismatch', 'parse', ['after_input']),
  declaration('schema_tools.database_description_invalid', 'parse', ['after_input']),
  declaration('schema_tools.database_description_unavailable', 'resolve', ['after_authority', 'after_refresh']),
  declaration('schema_tools.issue_catalog_hash_mismatch', 'parse', ['after_input']),
  declaration('schema_tools.issue_catalog_invalid', 'parse', ['after_input'])
]);

const declarations = new Map([...issueCatalog, ...schemaToolsIssueDeclarations.map((declaration) => [declaration.code, declaration] as const)]);

export const schemaToolsIssue = (code: string, details: JsonValue, retry?: IssueRetry): Issue => {
  const declaration = declarations.get(code);
  if (declaration === undefined) throw new TypeError('Unknown schema-tools issue code: ' + code);
  const resolvedRetry = retry ?? declaration.retries[0];
  if (resolvedRetry !== undefined && !declaration.retries.includes(resolvedRetry)) throw new TypeError('Invalid retry for schema-tools issue code: ' + code);
  return { id: code + ':' + canonicalizeJson(details), code, phase: declaration.phase, severity: declaration.severity, ...(resolvedRetry === undefined ? {} : { retry: resolvedRetry }), details };
};

export const schemaToolsFailure = <Value = never>(code: string, details: JsonValue): ParseResult<Value> => ({ success: false, issues: [schemaToolsIssue(code, details)] });
