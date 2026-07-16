/** Memoizes a pure analysis only when its input is immutable and safe to retain. */
export const memoizeFrozenAnalysis = <Input extends object, Output>(
  analyze: (input: Input) => Output
): ((input: Input) => Output) => {
  const noResult = Symbol();
  const cache = new WeakMap<Input, Output | typeof noResult>();
  return (input) => {
    const cached = cache.get(input);
    if (cached !== undefined) return cached === noResult ? undefined as Output : cached;
    const output = analyze(input);
    if (Object.isFrozen(input)) cache.set(input, output === undefined ? noResult : output);
    return output;
  };
};
