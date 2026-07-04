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
  let current: Pick<SelectedSnapshotRead<Source, Selected>, 'source' | 'selected'> | undefined;

  return () => {
    const nextSource = readSource();
    if (current !== undefined && sourceEqual(current.source, nextSource)) {
      return { source: current.source, selected: current.selected, changed: false };
    }

    const nextSelected = select(nextSource);
    if (current !== undefined && selectedEqual(current.selected, nextSelected)) {
      const selected = current.selected;
      current = { source: nextSource, selected };
      return { source: current.source, selected: current.selected, changed: false };
    }

    current = { source: nextSource, selected: nextSelected };
    return { source: current.source, selected: current.selected, changed: true };
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
