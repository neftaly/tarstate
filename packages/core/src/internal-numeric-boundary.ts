/** Adopts a positive integer capacity once at a public construction boundary. */
export const positiveSafeInteger = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(label + ' must be a positive safe integer');
  return value;
};
