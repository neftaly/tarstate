/** Portable document-declaration parsing without attachment lifecycle machinery. */
import { createIssue, type ParseResult } from '../../issues.js';
import { adoptDocumentDeclaration } from '../document-declaration.js';
import type { DocumentDeclaration } from '../model.js';

export type { DocumentDeclaration } from '../model.js';

/** Parses an untrusted portable declaration into one owned immutable value. */
export const safeParseDocumentDeclaration = (input: unknown): ParseResult<DocumentDeclaration> => {
  const declaration = adoptDocumentDeclaration(input);
  return declaration === undefined
    ? {
        success: false,
        issues: [createIssue({
          code: 'artifact.invalid_envelope',
          retry: 'after_input',
          details: { member: 'document_declaration' }
        })]
      }
    : { success: true, value: declaration, issues: [] };
};
