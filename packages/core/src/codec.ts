import { canonicalizeJson, sha256Json } from './artifacts.js';
import { createIssue, type CapabilityRef, type Issue, type ParseResult } from './issues.js';
import { CapabilityRegistry } from './registry.js';
import { isTaggedValue, safeParseJsonValue, type JsonValue, type PortableValue, type TaggedValue } from './value.js';

export type ScalarDeclaration =
  | { readonly kind: 'string'; readonly values?: readonly string[] }
  | { readonly kind: 'boolean' }
  | { readonly kind: 'number' }
  | { readonly kind: 'integer' }
  | { readonly kind: 'decimal' }
  | { readonly kind: 'instant'; readonly precision: 'millisecond' | 'microsecond' | 'nanosecond' }
  | { readonly kind: 'bytes' }
  | { readonly kind: 'json' }
  | { readonly kind: 'ref'; readonly target: { readonly relationId: string } }
  | { readonly kind: 'custom'; readonly codec: CapabilityRef };

/** A host codec is total: malformed input is a ParseResult, never an exception. */
export type CodecImplementation = {
  readonly kind: 'tarstate.codec';
  readonly type: string;
  readonly decode: (input: unknown) => ParseResult<TaggedValue>;
  readonly equals: (left: TaggedValue, right: TaggedValue) => boolean;
  readonly hash: (value: TaggedValue) => string;
  readonly compare?: (left: TaggedValue, right: TaggedValue) => number;
};

export type ScalarParseContext = {
  readonly registry?: CapabilityRegistry;
  readonly refFields?: (relationId: string) => readonly ScalarDeclaration[] | undefined;
  readonly path?: readonly unknown[];
};

export const parseScalarValue = (
  declaration: ScalarDeclaration,
  input: unknown,
  context: ScalarParseContext = {}
): ParseResult<PortableValue> => {
  const path = context.path ?? [];
  if (input === null) return failure('schema.null_not_allowed', path, { scalar: declaration.kind });

  if (declaration.kind === 'custom') return parseCustomValue(declaration.codec, input, context.registry, path);
  if (declaration.kind === 'ref') {
    const fields = context.refFields?.(declaration.target.relationId);
    if (fields === undefined) return failure('schema.ref_target_missing', path, { relationId: declaration.target.relationId });
    if (!Array.isArray(input) || input.length !== fields.length) {
      return failure('schema.ref_arity', path, { relationId: declaration.target.relationId, expected: fields.length, actual: Array.isArray(input) ? input.length : 'non_tuple' });
    }
    const tuple: PortableValue[] = [];
    const issues: Issue[] = [];
    fields.forEach((field, index) => {
      const parsed = parseScalarValue(field, input[index], { ...context, path: [...path, index] });
      if (parsed.success) tuple.push(parsed.value);
      else issues.push(...parsed.issues);
    });
    return issues.length === 0 ? { success: true, value: tuple, issues: [] } : { success: false, issues };
  }

  const portable = safeParseJsonValue(input);
  if (!portable.success) return { success: false, issues: portable.issues.map((issue) => contextualize(issue, path)) };
  const value = portable.value;
  switch (declaration.kind) {
    case 'string':
      if (typeof value !== 'string') return scalarTypeFailure(declaration.kind, path);
      if (declaration.values !== undefined && !declaration.values.includes(value)) return failure('schema.enum_value', path, { value, values: declaration.values });
      return success(value);
    case 'boolean':
      return typeof value === 'boolean' ? success(value) : scalarTypeFailure(declaration.kind, path);
    case 'number':
      return typeof value === 'number' ? success(value) : scalarTypeFailure(declaration.kind, path);
    case 'integer':
      return typeof value === 'number' && Number.isSafeInteger(value) ? success(value) : failure('schema.integer_invalid', path);
    case 'decimal':
      return parseBuiltInTagged(value, 'decimal', decimalPattern, path);
    case 'instant':
      return parseInstant(value, declaration.precision, path);
    case 'bytes':
      return parseBytes(value, path);
    case 'json':
      return success(value);
  }
};

export const scalarEquals = (left: PortableValue, right: PortableValue, codec?: CodecImplementation): boolean => {
  if (isTaggedValue(left) && isTaggedValue(right) && left.type === right.type && codec?.type === left.type) return codec.equals(left, right);
  return canonicalizeJson(left as JsonValue) === canonicalizeJson(right as JsonValue);
};

export const scalarHash = async (value: PortableValue, codec?: CodecImplementation): Promise<string> => {
  if (isTaggedValue(value) && codec?.type === value.type) return codec.hash(value);
  return sha256Json(value as JsonValue);
};

export const isCodecImplementation = (value: unknown): value is CodecImplementation => {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<CodecImplementation>;
  return candidate.kind === 'tarstate.codec' && typeof candidate.type === 'string' && typeof candidate.decode === 'function' && typeof candidate.equals === 'function' && typeof candidate.hash === 'function' && (candidate.compare === undefined || typeof candidate.compare === 'function');
};

const decimalPattern = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/;
const instantPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{9})Z$/;
const bytesPattern = /^[A-Za-z0-9_-]*$/;

const parseCustomValue = (ref: CapabilityRef, input: unknown, registry: CapabilityRegistry | undefined, path: readonly unknown[]): ParseResult<PortableValue> => {
  const registered = registry?.implementation(ref)?.implementation;
  if (!isCodecImplementation(registered)) {
    return failure('schema.codec_unavailable', path, { codec: ref }, [ref], 'after_capability');
  }
  try {
    const decoded = registered.decode(input);
    if (!decoded.success) return { success: false, issues: decoded.issues.map((issue) => contextualize(issue, path)) };
    const value = decoded.value;
    const portable = safeParseJsonValue(value);
    if (!portable.success || !isTaggedValue(portable.value) || portable.value.type !== registered.type || !exactTaggedShape(portable.value)) {
      return failure('schema.codec_failed', path, { codec: ref, reason: 'invalid_output' }, [ref]);
    }
    return success(value);
  } catch (error) {
    return failure('schema.codec_failed', path, { codec: ref, reason: 'threw', error: error instanceof Error ? error.name : typeof error }, [ref]);
  }
};

const parseBuiltInTagged = (value: JsonValue, type: string, pattern: RegExp, path: readonly unknown[]): ParseResult<PortableValue> => {
  if (!isTaggedValue(value) || !exactTaggedShape(value) || value.type !== type || typeof value.value !== 'string' || !pattern.test(value.value) || (type === 'decimal' && value.value === '-0')) {
    return failure(`schema.${type}_invalid`, path);
  }
  return success(value);
};

const parseInstant = (value: JsonValue, precision: 'millisecond' | 'microsecond' | 'nanosecond', path: readonly unknown[]): ParseResult<PortableValue> => {
  if (!isTaggedValue(value) || !exactTaggedShape(value) || value.type !== 'instant' || typeof value.value !== 'string') return failure('schema.instant_invalid', path);
  const match = instantPattern.exec(value.value);
  if (match === null) return failure('schema.instant_invalid', path);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = ''] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const validDay = day >= 1 && day <= daysInMonth(year, month);
  if (month < 1 || month > 12 || !validDay || Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText) > 59) return failure('schema.instant_invalid', path);
  if (precision === 'millisecond' && !fraction.endsWith('000000')) return failure('schema.instant_precision', path, { precision });
  if (precision === 'microsecond' && !fraction.endsWith('000')) return failure('schema.instant_precision', path, { precision });
  return success(value);
};

const parseBytes = (value: JsonValue, path: readonly unknown[]): ParseResult<PortableValue> => {
  if (!isTaggedValue(value) || !exactTaggedShape(value) || value.type !== 'bytes' || typeof value.value !== 'string' || !bytesPattern.test(value.value) || value.value.length % 4 === 1) {
    return failure('schema.bytes_invalid', path);
  }
  if (value.value.length > 0) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = alphabet.indexOf(value.value.at(-1) as string);
    const remainder = value.value.length % 4;
    if ((remainder === 2 && (last & 0b1111) !== 0) || (remainder === 3 && (last & 0b11) !== 0)) return failure('schema.bytes_invalid', path, { reason: 'non_zero_trailing_bits' });
  }
  return success(value);
};

const daysInMonth = (year: number, month: number): number => {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : month >= 1 && month <= 12 ? 31 : 0;
};

const exactTaggedShape = (value: TaggedValue): boolean => {
  const keys = Object.keys(value).sort();
  return keys.length === 3 && keys[0] === 'kind' && keys[1] === 'type' && keys[2] === 'value';
};

const success = <Value extends PortableValue>(value: Value): ParseResult<Value> => ({ success: true, value, issues: [] });

const scalarTypeFailure = (expected: string, path: readonly unknown[]): ParseResult<never> => failure('schema.scalar_type', path, { expected });

const failure = (
  code: string,
  path: readonly unknown[],
  details?: unknown,
  requiredCapabilities?: readonly CapabilityRef[],
  retry: 'after_input' | 'after_capability' = 'after_input'
): ParseResult<never> => ({
  success: false,
  issues: [createIssue({
    code,
    phase: 'parse',
    severity: 'error',
    retry,
    path,
    ...(details === undefined ? {} : { details }),
    ...(requiredCapabilities === undefined ? {} : { requiredCapabilities })
  })]
});

const contextualize = (issue: Issue, prefix: readonly unknown[]): Issue => ({
  ...issue,
  path: [...prefix, ...(issue.path ?? [])]
});
