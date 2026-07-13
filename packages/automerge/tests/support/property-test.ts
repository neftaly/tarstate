import fc, { type IRawProperty } from 'fast-check';
import { it } from 'vitest';

const parseInteger = (value: string | undefined): number | undefined => {
  if (value === undefined || !/^-?\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
};

const defaultBaseSeed = 1_264_843_000;
const configuredRuns = parseInteger(process.env.TARSTATE_FUZZ_RUNS);
const configuredSeed = parseInteger(process.env.TARSTATE_FUZZ_SEED);
const selectedProperty = process.env.TARSTATE_FUZZ_PROPERTY;
const replayPath = process.env.TARSTATE_FUZZ_PATH;

/** Register one independently seeded, shrinkable, and replayable property. */
export const propertyTest = <Ts>(name: string, property: IRawProperty<Ts>): void => {
  const selected = selectedProperty === undefined || selectedProperty === name;
  const test = selected ? it : it.skip;
  test(name, async () => {
    const baseSeed = configuredSeed ?? defaultBaseSeed;
    const seed = selectedProperty === name ? baseSeed : derivePropertySeed(baseSeed, name);
    await fc.assert(property, {
      seed,
      numRuns: configuredRuns !== undefined && configuredRuns > 0 ? configuredRuns : 100,
      ...(replayPath === undefined || replayPath.length === 0 ? {} : { path: replayPath })
    });
  });
};

const derivePropertySeed = (baseSeed: number, propertyName: string): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < propertyName.length; index += 1) {
    hash ^= propertyName.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (baseSeed ^ hash) | 0;
};
