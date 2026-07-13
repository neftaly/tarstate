import {
  useDebugValue,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore
} from 'react';

export const useExternalStoreWithSelector = <Snapshot, Selected>(
  subscribe: (listener: () => void) => () => void,
  getSnapshot: () => Snapshot,
  getServerSnapshot: (() => Snapshot) | undefined,
  selector: (snapshot: Snapshot) => Selected,
  isEqual: (left: Selected, right: Selected) => boolean
): Selected => {
  const selectedRef = useRef<{ readonly hasValue: false } | { readonly hasValue: true; readonly value: Selected }>({ hasValue: false });
  const [getSelectedSnapshot, getSelectedServerSnapshot] = useMemo(() => {
    let hasMemo = false;
    let memoSnapshot: Snapshot;
    let memoSelection: Selected;
    const selectSnapshot = (snapshot: Snapshot): Selected => {
      if (!hasMemo) {
        hasMemo = true;
        memoSnapshot = snapshot;
        const selected = selector(snapshot);
        if (selectedRef.current.hasValue && isEqual(selectedRef.current.value, selected)) {
          memoSelection = selectedRef.current.value;
          return memoSelection;
        }
        memoSelection = selected;
        return selected;
      }
      if (Object.is(memoSnapshot, snapshot)) return memoSelection;
      const selected = selector(snapshot);
      memoSnapshot = snapshot;
      if (isEqual(memoSelection, selected)) return memoSelection;
      memoSelection = selected;
      return selected;
    };
    return [
      () => selectSnapshot(getSnapshot()),
      getServerSnapshot === undefined ? undefined : () => selectSnapshot(getServerSnapshot())
    ] as const;
  }, [getSnapshot, getServerSnapshot, isEqual, selector]);
  const selected = useSyncExternalStore(subscribe, getSelectedSnapshot, getSelectedServerSnapshot);
  useEffect(() => {
    selectedRef.current = { hasValue: true, value: selected };
  }, [selected]);
  useDebugValue(selected);
  return selected;
};
