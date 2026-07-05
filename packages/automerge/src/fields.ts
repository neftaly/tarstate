import * as Automerge from '@automerge/automerge';
import {
  customField,
  type CustomFieldSpec,
  type FieldSpec
} from '@tarstate/core/schema';

import { compareValues, isRecord, stableKey } from './value.js';

export type AutomergeObjectPath = readonly Automerge.Prop[];
export type AutomergeObjectReference = {
  readonly objectId: Automerge.ObjID;
  readonly path?: AutomergeObjectPath;
  readonly heads?: Automerge.Heads;
  readonly documentId?: string;
  readonly branch?: string;
  readonly relation?: string;
  readonly key?: unknown;
  readonly detail?: unknown;
};
export type AutomergeObjectReferenceOptions = Omit<AutomergeObjectReference, 'objectId' | 'path'>;
export type AutomergeTextValue = string | Automerge.ImmutableString;
export type AutomergeCounterValue = number | Automerge.Counter;
const automergeNativeFieldKind = Symbol.for('tarstate.automerge.nativeFieldKind');

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

const isHexString = (value: unknown): value is string =>
  typeof value === 'string' && value.length % 2 === 0 && /^[0-9a-f]*$/iu.test(value);

const hexToBytes = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) return value;
  if (!isHexString(value)) throw new TypeError('Automerge bytes fields must be encoded as even-length hex strings');

  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
};

const bytesScalar = (value: unknown): string =>
  value instanceof Uint8Array ? bytesToHex(value) : isHexString(value) ? value.toLowerCase() : '';

const bytesValue = (value: unknown): Uint8Array | undefined =>
  value instanceof Uint8Array ? value : isHexString(value) ? hexToBytes(value) : undefined;

const isValidDateScalar = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const time = Date.parse(value);
  return Number.isFinite(time);
};

const scalarToDate = (value: unknown): Date => {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value;
  if (!isValidDateScalar(value)) throw new TypeError('Automerge date fields must be valid date strings');

  return new Date(value);
};

const dateTime = (value: unknown): number | undefined => {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.getTime();
  if (isValidDateScalar(value)) return Date.parse(value);
  return undefined;
};

const dateScalar = (value: unknown): string => {
  const time = dateTime(value);
  return time === undefined ? '' : new Date(time).toISOString();
};

const scalarToCounter = (value: unknown): Automerge.Counter => {
  if (Automerge.isCounter(value)) return value;
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) throw new TypeError('Automerge counter fields must be finite numbers');
  return new Automerge.Counter(numberValue);
};

const compareByteArrays = (left: Uint8Array, right: Uint8Array): number => {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const compared = (left[index] ?? 0) - (right[index] ?? 0);
    if (compared !== 0) return compared;
  }

  return left.length - right.length;
};

export function automergeTextField(
  options: Partial<CustomFieldSpec<unknown>> = {}
): FieldSpec<string> {
  return customScalarField<string>(automergeCustomSpec('automerge.text', {
    description: 'an Automerge text value',
    validate: (value): value is unknown =>
      typeof value === 'string' || Automerge.isImmutableString(value),
    toScalar: (value) => String(value),
    fromScalar: (value) => Automerge.isImmutableString(value)
      ? value
      : new Automerge.ImmutableString(String(value)),
    stableKey: (value) => String(value),
    compare: (left, right) => String(left).localeCompare(String(right))
  }, options));
}

export function automergeCounterField(
  options: Partial<CustomFieldSpec<unknown>> = {}
): FieldSpec<number> {
  return customScalarField<number>(automergeCustomSpec('automerge.counter', {
    description: 'an Automerge counter value',
    validate: (value): value is unknown =>
      typeof value === 'number' && Number.isFinite(value) || Automerge.isCounter(value),
    toScalar: (value) => Number(value),
    fromScalar: scalarToCounter,
    stableKey: (value) => String(Number(value)),
    compare: (left, right) => Number(left) - Number(right)
  }, options));
}

export function automergeBytesField(
  options: Partial<CustomFieldSpec<unknown>> = {}
): FieldSpec<string> {
  return customScalarField<string>(automergeCustomSpec('automerge.bytes', {
    description: 'an Automerge bytes value',
    validate: (value): value is unknown => value instanceof Uint8Array || isHexString(value),
    toScalar: bytesScalar,
    fromScalar: hexToBytes,
    stableKey: bytesScalar,
    compare: (left, right) => {
      const leftBytes = bytesValue(left);
      const rightBytes = bytesValue(right);
      return leftBytes !== undefined && rightBytes !== undefined ? compareByteArrays(leftBytes, rightBytes) : compareValues(left, right);
    }
  }, options));
}

export function automergeDateField(
  options: Partial<CustomFieldSpec<unknown>> = {}
): FieldSpec<string> {
  return customScalarField<string>(automergeCustomSpec('automerge.date', {
    description: 'an Automerge date value',
    validate: (value): value is unknown =>
      (value instanceof Date && !Number.isNaN(value.valueOf())) || isValidDateScalar(value),
    toScalar: dateScalar,
    fromScalar: scalarToDate,
    stableKey: dateScalar,
    compare: (left, right) => {
      const leftTime = dateTime(left);
      const rightTime = dateTime(right);
      return leftTime !== undefined && rightTime !== undefined ? leftTime - rightTime : compareValues(left, right);
    }
  }, options));
}

export function automergeObjectReferenceField(
  options: Partial<CustomFieldSpec<unknown>> = {}
): FieldSpec<AutomergeObjectReference> {
  return customScalarField<AutomergeObjectReference>(automergeCustomSpec('automerge.objectReference', {
    description: 'an Automerge object reference',
    validate: isAutomergeObjectReference,
    stableKey,
    compare: (left, right) => stableKey(left).localeCompare(stableKey(right))
  }, options));
}

type AutomergeCustomSpecDefaults = Omit<CustomFieldSpec<unknown>, 'codec'>;

function automergeCustomSpec(
  defaultCodec: string,
  defaults: AutomergeCustomSpecDefaults,
  options: Partial<CustomFieldSpec<unknown>>
): CustomFieldSpec<unknown> {
  const merged = { ...defaults, ...options };
  return withAutomergeNativeFieldKind({ ...merged, codec: options.codec ?? defaultCodec }, defaultCodec);
}

function customScalarField<Value>(spec: CustomFieldSpec<unknown>): FieldSpec<Value> {
  const field = customField<unknown>(spec);
  const nativeKind = (spec as Record<symbol, string | undefined>)[automergeNativeFieldKind];
  if (nativeKind !== undefined && field.custom !== undefined) {
    Object.defineProperty(field.custom, automergeNativeFieldKind, {
      value: nativeKind,
      enumerable: false
    });
  }
  return field as FieldSpec<Value>;
}

function withAutomergeNativeFieldKind(
  spec: CustomFieldSpec<unknown>,
  nativeKind: string
): CustomFieldSpec<unknown> {
  Object.defineProperty(spec, automergeNativeFieldKind, {
    value: nativeKind,
    enumerable: false
  });
  return spec;
}

function isAutomergeObjectReference(input: unknown): boolean {
  if (!isRecord(input) || typeof input.objectId !== 'string') return false;
  if (input.path !== undefined && !isAutomergePath(input.path)) return false;
  if (input.heads !== undefined && !isStringArray(input.heads)) return false;
  if (input.documentId !== undefined && typeof input.documentId !== 'string') return false;
  if (input.branch !== undefined && typeof input.branch !== 'string') return false;
  if (input.relation !== undefined && typeof input.relation !== 'string') return false;
  return true;
}

function isAutomergePath(input: unknown): input is readonly Automerge.Prop[] {
  return Array.isArray(input) && input.every((segment) =>
    typeof segment === 'string' || typeof segment === 'number');
}

function isStringArray(input: unknown): input is readonly string[] {
  return Array.isArray(input) && input.every((item) => typeof item === 'string');
}
