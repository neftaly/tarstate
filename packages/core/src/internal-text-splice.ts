export type TextSpliceRange = {
  readonly index: number;
  readonly deleteCount: number;
  readonly insert: string;
};

/** Pure UTF-16 contract shared by semantic authoring and transaction evaluation. */
export const isValidUtf16TextSplice = (value: string, edit: TextSpliceRange): boolean =>
  Number.isSafeInteger(edit.index)
  && edit.index >= 0
  && Number.isSafeInteger(edit.deleteCount)
  && edit.deleteCount >= 0
  && edit.index <= value.length
  && edit.deleteCount <= value.length - edit.index
  && isCodePointBoundary(value, edit.index)
  && isCodePointBoundary(value, edit.index + edit.deleteCount)
  && isWellFormedUtf16(edit.insert);

const isCodePointBoundary = (value: string, index: number): boolean => index === 0
  || index === value.length
  || !isHighSurrogate(value.charCodeAt(index - 1))
  || !isLowSurrogate(value.charCodeAt(index));

const isWellFormedUtf16 = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (isHighSurrogate(unit)) {
      if (index + 1 >= value.length || !isLowSurrogate(value.charCodeAt(index + 1))) return false;
      index += 1;
    } else if (isLowSurrogate(unit)) {
      return false;
    }
  }
  return true;
};

const isHighSurrogate = (unit: number): boolean => unit >= 0xD800 && unit <= 0xDBFF;
const isLowSurrogate = (unit: number): boolean => unit >= 0xDC00 && unit <= 0xDFFF;
