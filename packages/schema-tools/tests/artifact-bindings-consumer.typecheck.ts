import type { DatabaseTransactionSnapshot } from '@tarstate/core/transactions';
import { compositeRelation } from './artifact-bindings.typecheck.js';

declare const snapshot: DatabaseTransactionSnapshot;

snapshot.spliceText(
  compositeRelation,
  ['text', 'file'],
  'textContent',
  { index: 0, deleteCount: 0, insert: 'New ' }
);

snapshot.spliceText(
  compositeRelation,
  // @ts-expect-error imported generated relations retain exact composite-key order
  ['file', 'text'],
  'textContent',
  { index: 0, deleteCount: 0, insert: 'New ' }
);
