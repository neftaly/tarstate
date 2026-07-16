import * as Automerge from '@automerge/automerge';
import type {
  ParseResult
} from '@tarstate/core';
import {
  safeMaterializePortableBytes,
  toPortableBytes,
  type PortableBytes
} from '@tarstate/core/values';
import type {
  StorageScalarCodecInput,
  StorageScalarDecoder
} from '@tarstate/core/schema';

/** Canonical scalar conversion at the Automerge storage boundary. */
export const createAutomergeStorageScalarCodec = (): {
  readonly decode: StorageScalarDecoder;
  readonly encode: (input: StorageScalarCodecInput) => ParseResult<unknown>;
} => {
  const logicalBytes = new WeakMap<Uint8Array, PortableBytes>();
  return {
    decode: (input) => {
      if (input.declaration.type.kind === 'string' && Automerge.isImmutableString(input.value)) {
        return success(input.value.toString());
      }
      if (input.declaration.type.kind !== 'bytes' || !(input.value instanceof Uint8Array)) {
        return success(input.value);
      }
      const cached = logicalBytes.get(input.value);
      if (cached !== undefined) return success(cached);
      const value = toPortableBytes(input.value);
      logicalBytes.set(input.value, value);
      return success(value);
    },
    encode: (input) => {
      if (input.declaration.type.kind !== 'bytes') return success(input.value);
      return safeMaterializePortableBytes(input.value);
    }
  };
};

const success = <Value>(value: Value): ParseResult<Value> => ({ success: true, value, issues: [] });
