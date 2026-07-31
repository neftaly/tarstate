import { sameStructuralJson } from './internal-structural-json-equality.js';

/** Safe canonical equality for values entering through structurally typed protocols. */
export const samePortableJson = sameStructuralJson;
