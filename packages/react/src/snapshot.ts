export type SelectedSnapshotRead<Source, Selected> = {
  readonly source: Source;
  readonly selected: Selected;
  readonly changed: boolean;
};

export function selectedSnapshotReader<Source, Selected>(
  readSource: () => Source,
  select: (source: Source) => Selected,
  sourceEqual: (left: Source, right: Source) => boolean,
  selectedEqual: (left: Selected, right: Selected) => boolean
): () => SelectedSnapshotRead<Source, Selected> {
  let currentSource: Source;
  let currentSelected: Selected;
  let hasCurrent = false;

  return () => {
    const nextSource = readSource();
    if (hasCurrent && sourceEqual(currentSource, nextSource)) {
      return { source: currentSource, selected: currentSelected, changed: false };
    }

    const nextSelected = select(nextSource);
    if (hasCurrent && selectedEqual(currentSelected, nextSelected)) {
      currentSource = nextSource;
      return { source: nextSource, selected: currentSelected, changed: false };
    }

    currentSource = nextSource;
    currentSelected = nextSelected;
    hasCurrent = true;
    return { source: nextSource, selected: nextSelected, changed: true };
  };
}

export function stableSnapshotReader<Snapshot>(
  readSnapshot: () => Snapshot,
  areEqual: (left: Snapshot, right: Snapshot) => boolean
): () => Snapshot {
  let current: Snapshot;
  let hasCurrent = false;

  return () => {
    const next = readSnapshot();
    if (hasCurrent && areEqual(current, next)) return current;
    current = next;
    hasCurrent = true;
    return current;
  };
}
