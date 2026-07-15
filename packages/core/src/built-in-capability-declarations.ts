import type { CapabilityDeclaration } from './capability-model.js';
import type { CapabilityRef } from './issues.js';

const ref = (suffix: string, hash: string): CapabilityRef => ({
  id: 'urn:tarstate:capability:' + suffix,
  version: '1',
  contractHash: `sha256:${hash}`
});

export const builtInCapabilityRefs = {
  fieldReplace: ref('field/replace', 'b60c245fe7811ce744805e1cd6c22ad9f270879e46bc03299fbd5270122afb74'),
  counterIncrement: ref('field/counter-increment', '9df5e2507b3d10ca1d40c3e7b0b42c9c6de272a02ebaee8b69a838206f881963'),
  textSplice: ref('field/text-splice', '9a9cc22f2768d5de353a390682e17430952614e8e30eb8fc12992170d4c5d0fc'),
  conflictResolve: ref('field/conflict-resolve', 'd2f90f3c1fcda78718037d6c4c1d27b7155e276c92c14fd2c2d4fb08aa9729d3'),
  move: ref('entity/move', '4406275cc0916b33bf7cde7ef69f07be2788f0fe1e903b792f44ff3e238dcdc6'),
  rekey: ref('entity/rekey', '1cdfeb0b1e43c76df6b4fd5774c37eca5f33c3d17310caa9a11a88489f020e5f'),
  copyRelocate: ref('entity/copy-relocate', '0403e04d4800fc6e143d8e91c98605e72445a0af94d58c7bbcfc7cf450d1d44b'),
  identityPreservingMove: ref('entity/identity-preserving-move', '0a6ab736c23054f2b6dac6c5baa671769a078ac57c3540b73e63878c26442cb5'),
  requiredLocalEnforcement: ref('constraint/required-local-enforcement', 'f339e39b0df5dfc61fc65eb953be4fa57221be6ec4c85b14f00f113c1eaa9e46'),
  durableOperationReceipts: ref('source/durable-operation-receipts', 'f6a5fc6304dc80d2b3449caf78518839967f483992541539b9f49f90a440c771')
} as const;

const declaration = (
  suffix: string,
  capabilityClass: CapabilityDeclaration['class'],
  implies: readonly CapabilityRef[] = []
): CapabilityDeclaration => ({
  kind: 'tarstate.capability-contract',
  formatVersion: 1,
  id: 'urn:tarstate:capability:' + suffix,
  version: '1',
  class: capabilityClass,
  contract: { operation: suffix },
  implies
});

export const builtInCapabilityDeclarations: readonly CapabilityDeclaration[] = [
  declaration('field/replace', 'edit'),
  declaration('field/counter-increment', 'edit'),
  declaration('field/text-splice', 'edit'),
  declaration('field/conflict-resolve', 'edit'),
  declaration('entity/move', 'edit'),
  declaration('entity/rekey', 'edit'),
  declaration('entity/copy-relocate', 'edit', [builtInCapabilityRefs.move]),
  declaration('entity/identity-preserving-move', 'edit', [builtInCapabilityRefs.move]),
  declaration('constraint/required-local-enforcement', 'executor'),
  declaration('source/durable-operation-receipts', 'source')
];
