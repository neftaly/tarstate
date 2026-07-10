import type { CapabilityRef, JsonValue } from './wire.js';

export type CapabilityDeclaration = {
  readonly kind: 'tarstate.capability-contract';
  readonly formatVersion: 1;
  readonly id: string;
  readonly version: '1';
  readonly class: 'edit' | 'executor' | 'source';
  readonly contract: JsonValue;
  readonly implies: readonly CapabilityRef[];
};

const prefix = 'urn:tarstate:capability:';

const hashes = {
  'field/replace': 'sha256:b60c245fe7811ce744805e1cd6c22ad9f270879e46bc03299fbd5270122afb74',
  'field/counter-increment': 'sha256:9df5e2507b3d10ca1d40c3e7b0b42c9c6de272a02ebaee8b69a838206f881963',
  'field/text-splice': 'sha256:9a9cc22f2768d5de353a390682e17430952614e8e30eb8fc12992170d4c5d0fc',
  'field/conflict-resolve': 'sha256:d2f90f3c1fcda78718037d6c4c1d27b7155e276c92c14fd2c2d4fb08aa9729d3',
  'entity/move': 'sha256:4406275cc0916b33bf7cde7ef69f07be2788f0fe1e903b792f44ff3e238dcdc6',
  'entity/rekey': 'sha256:1cdfeb0b1e43c76df6b4fd5774c37eca5f33c3d17310caa9a11a88489f020e5f',
  'entity/copy-relocate': 'sha256:0403e04d4800fc6e143d8e91c98605e72445a0af94d58c7bbcfc7cf450d1d44b',
  'entity/identity-preserving-move': 'sha256:0a6ab736c23054f2b6dac6c5baa671769a078ac57c3540b73e63878c26442cb5',
  'constraint/required-local-enforcement': 'sha256:f339e39b0df5dfc61fc65eb953be4fa57221be6ec4c85b14f00f113c1eaa9e46',
  'source/durable-operation-receipts': 'sha256:f6a5fc6304dc80d2b3449caf78518839967f483992541539b9f49f90a440c771'
} as const;

export type BuiltinCapabilitySuffix = keyof typeof hashes;

export const capabilityRef = (suffix: BuiltinCapabilitySuffix): CapabilityRef => ({
  id: prefix + suffix,
  version: '1',
  contractHash: hashes[suffix]
});

const capabilityClass = (suffix: BuiltinCapabilitySuffix): CapabilityDeclaration['class'] => {
  if (suffix.startsWith('field/') || suffix.startsWith('entity/')) return 'edit';
  if (suffix.startsWith('constraint/')) return 'executor';
  return 'source';
};

export const capabilityDeclaration = (suffix: BuiltinCapabilitySuffix): CapabilityDeclaration => ({
  kind: 'tarstate.capability-contract',
  formatVersion: 1,
  id: prefix + suffix,
  version: '1',
  class: capabilityClass(suffix),
  contract: { operation: suffix },
  implies: suffix === 'entity/copy-relocate' || suffix === 'entity/identity-preserving-move'
    ? [capabilityRef('entity/move')]
    : []
});

export const builtinCapabilitySuffixes = Object.freeze(Object.keys(hashes) as BuiltinCapabilitySuffix[]);
