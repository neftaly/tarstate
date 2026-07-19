import * as Automerge from '@automerge/automerge';
import { adoptAutomergeBasis } from '../shared/basis-adoption.js';

export type AutomergeDocumentViewResult<T extends object> =
  | { readonly success: true; readonly value: Automerge.Doc<T> }
  | {
      readonly success: false;
      readonly reason:
        | 'invalid-basis'
        | 'unsupported-basis'
        | 'document-unavailable'
        | 'basis-unavailable'
        | 'invalid-document';
    };

const documentUnavailable = Object.freeze({ success: false, reason: 'document-unavailable' } as const);
const basisUnavailable = Object.freeze({ success: false, reason: 'basis-unavailable' } as const);
const invalidDocument = Object.freeze({ success: false, reason: 'invalid-document' } as const);

/** Materializes an immutable exact-head view without fetching or changing ownership. */
export const viewAutomergeDocumentAtBasis = <T extends object>(
  document: Automerge.Doc<T> | undefined,
  basis: unknown
): AutomergeDocumentViewResult<T> => {
  const adopted = adoptAutomergeBasis(basis);
  if (!adopted.success) return adopted;
  if (document === undefined) return documentUnavailable;
  try {
    const heads = [...adopted.value.heads];
    if (!Automerge.hasHeads(document, heads)) {
      return basisUnavailable;
    }
    const view = Automerge.view(document, heads);
    return { success: true, value: view };
  } catch {
    return invalidDocument;
  }
};
