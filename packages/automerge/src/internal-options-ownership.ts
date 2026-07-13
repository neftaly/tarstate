import type { JsonValue } from '@tarstate/core';
import type { AutomergePath } from './projection.js';

type Parser<Row> = (candidate: unknown, context: { readonly mapKey: string; readonly path: AutomergePath }) =>
  | { readonly success: true; readonly row: Row }
  | { readonly success: false; readonly issue: { readonly code: string; readonly path?: AutomergePath; readonly details?: Readonly<Record<string, unknown>> } };

export type OwnedAutomergeMapOptions<Row extends Readonly<Record<string, JsonValue>>> = {
  readonly relationId: string;
  readonly collectionPath: AutomergePath;
  readonly missingCollection: 'empty' | 'invalid';
  readonly keySource: 'map-key' | { readonly field: string };
  readonly locatorNamespace?: string;
  readonly parse?: Parser<Row>;
};

type OwnedAutomergeMapStorageBindingOptions<Row extends Readonly<Record<string, JsonValue>>> =
  OwnedAutomergeMapOptions<Row> & { readonly id?: string };

type DataDescriptors = Readonly<Record<string, PropertyDescriptor>>;

const inspectOptions = (input: unknown): DataDescriptors => {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Automerge map options must be a record');
  return Object.getOwnPropertyDescriptors(input);
};

const valueOf = (descriptors: DataDescriptors, key: string): unknown => {
  const descriptor = descriptors[key];
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor)) throw new TypeError('Automerge map option ' + key + ' has a hostile property descriptor');
  return descriptor.value;
};

const adoptString = (value: unknown, label: string): string => {
  if (typeof value !== 'string') throw new TypeError(label + ' must be a string');
  return value;
};

const adoptPath = (input: unknown): AutomergePath => {
  if (!Array.isArray(input)) throw new TypeError('Automerge collectionPath must be an array');
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const length = (Reflect.get(descriptors, 'length') as PropertyDescriptor | undefined)?.value;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) throw new TypeError('Automerge collectionPath has a hostile length');
  const path: (string | number)[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError('Automerge collectionPath contains a hostile property descriptor');
    }
    if (
      typeof descriptor.value !== 'string'
      && (typeof descriptor.value !== 'number' || !Number.isSafeInteger(descriptor.value) || descriptor.value < 0)
    ) {
      throw new TypeError('Automerge collectionPath entries must be strings or non-negative safe integers');
    }
    path.push(descriptor.value);
  }
  return Object.freeze(path);
};

const adoptKeySource = (input: unknown): OwnedAutomergeMapOptions<Readonly<Record<string, JsonValue>>>['keySource'] => {
  if (input === 'map-key') return input;
  const descriptors = inspectOptions(input);
  if (!Object.hasOwn(descriptors, 'field')) throw new TypeError('Automerge keySource must contain field');
  return Object.freeze({ field: adoptString(valueOf(descriptors, 'field'), 'Automerge keySource field') });
};

const adoptBase = <Row extends Readonly<Record<string, JsonValue>>>(descriptors: DataDescriptors): OwnedAutomergeMapOptions<Row> => {
  const missingCollection = valueOf(descriptors, 'missingCollection');
  if (missingCollection !== 'empty' && missingCollection !== 'invalid') throw new TypeError('Automerge missingCollection is invalid');
  const locatorNamespace = valueOf(descriptors, 'locatorNamespace');
  const parse = valueOf(descriptors, 'parse');
  if (parse !== undefined && typeof parse !== 'function') throw new TypeError('Automerge parse must be a function');
  return Object.freeze({
    relationId: adoptString(valueOf(descriptors, 'relationId'), 'Automerge relationId'),
    collectionPath: adoptPath(valueOf(descriptors, 'collectionPath')),
    missingCollection,
    keySource: adoptKeySource(valueOf(descriptors, 'keySource')),
    ...(locatorNamespace === undefined ? {} : { locatorNamespace: adoptString(locatorNamespace, 'Automerge locatorNamespace') }),
    ...(parse === undefined ? {} : { parse: parse as Parser<Row> })
  });
};

export const adoptAutomergeMapOptions = <Row extends Readonly<Record<string, JsonValue>>>(input: unknown): OwnedAutomergeMapOptions<Row> =>
  adoptBase<Row>(inspectOptions(input));

export const adoptAutomergeMapStorageBindingOptions = <Row extends Readonly<Record<string, JsonValue>>>(input: unknown): OwnedAutomergeMapStorageBindingOptions<Row> => {
  const descriptors = inspectOptions(input);
  const base = adoptBase<Row>(descriptors);
  const id = valueOf(descriptors, 'id');
  return Object.freeze({ ...base, ...(id === undefined ? {} : { id: adoptString(id, 'Automerge binding id') }) });
};
