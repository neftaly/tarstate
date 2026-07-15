import {
  builtInCapabilityDeclarations,
  builtInCapabilityRefs
} from './built-in-capability-declarations.js';
import { capabilityRefFor, type CapabilityRegistry } from './registry.js';

export * from './built-in-capability-declarations.js';

export const verifyBuiltInCapabilities = async (): Promise<boolean> => {
  const refs = await Promise.all(builtInCapabilityDeclarations.map(capabilityRefFor));
  return refs.every((candidate) => Object.values(builtInCapabilityRefs).some((expected) => expected.id === candidate.id && expected.version === candidate.version && expected.contractHash === candidate.contractHash));
};

export const registerBuiltInCapabilities = async (registry: CapabilityRegistry): Promise<void> => {
  for (const candidate of builtInCapabilityDeclarations) {
    const registered = await registry.registerDeclaration(candidate);
    if (!registered.success) throw new Error(registered.issues.map(({ code }) => code).join(', '));
  }
};
