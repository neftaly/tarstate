export {
  relationFieldCompareToBound,
  relationFieldKeyInputValue,
  relationFieldKeyValue,
  relationFieldLookupMatches,
  relationFieldReadValue,
  relationFieldSpecDescription,
  relationFieldValueInRange,
  relationFieldValueMatchesSpec,
  relationKeyFields,
  relationKeyInputKey,
  relationKeyInputValues,
  relationKeyInputMatchesRow,
  relationRowKeyMatchesRow,
  rowKey as relationRowKey,
  validateRelationRow
} from './impl.js';
export type { RelationKeyInput, RelationRow } from './impl.js';
export {
  parseSingleRelationRow,
  singleRelationInput
} from './relation-set.js';
export type {
  ParseSingleRelationRowOptions,
  ParseSingleRelationRowResult,
  RelationInputEnvelope,
  SingleRelationRowBoundary
} from './relation-set.js';
