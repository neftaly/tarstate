# @tarstate/react

`@tarstate/react` is the React integration for the TypeScript Relic-style
Tarstate core. The React layer owns subscription and render safety; data reads
and writes go through the canonical `Store` API from `@tarstate/core/store`.

Primary API:

- `TarstateProvider` accepts either a core `store` or provider-owned
  `initialDb` seed data. When no store is provided, React creates a core
  `Store` with `createStore(initialDb)`.
- `useTarstateStore()` returns the active core `Store`.
- `useTarstateSnapshot()` subscribes with `store.subscribe` and returns the
  current core `StoreSnapshot` from `store.getSnapshot`.
- `useDb()` reads the current core `Db`.
- `useView(query, { resetKey })` is the canonical read hook for rendered rows.
  It creates a core `StoreView`, subscribes to it, and returns synchronous rows,
  diagnostics, revision, query key, and a refresh callback.
- `useRow(query, predicate)` returns the first view row matching a type-safe
  predicate.
- `useRow(relation, key)` returns the matching relation row by key.
- `useViewSelector(query, { select, equality, resetKey })` subscribes to a local
  `StoreView` and returns selected synchronous data for React render output. It
  is not an async or network query hook. Without `select`, `data` is the view
  rows. `equality` compares selected values and can skip renders when the
  selected result is equivalent.
- `shallow(left, right)` is an intentionally shallow selector equality helper
  for `Object.is`, arrays, and plain records.
- `useViewSubscription(query, { fireImmediately, onChange })` subscribes
  imperatively to a local `StoreView` without scheduling React renders. Without
  `select`, `onChange(snapshot)` receives the current `StoreViewSnapshot`. With
  `useViewSubscription(query, { fireImmediately, select, equality, onChange })`,
  `select(snapshot)` derives the delivered value and
  `onChange(selected, snapshot)` writes it into an external target. Changing
  `select`, `equality`, `resetKey`, or the query replaces the subscription;
  changing `onChange` only updates the callback used by the active subscription.
- `useCommit()` returns the active core `Store.commit` function.
- `Store.close()` provides idempotent subscription cleanup.

Core materialization helpers retain their core shapes. React keeps these thin:
materialized rows, commit diagnostics, and DB snapshots pass through as core
data rather than React-specific models. Materialize seed data with core helpers
before passing it to `createStore` or `TarstateProvider` as `initialDb`, then
read the query with `useView`.

Keep schemas, queries, and write patch builders in plain TypeScript modules so
they can be tested directly against `@tarstate/core` without rendering React.

## Selector reads

Use `useViewSelector` when a component renders a derived value instead of the
full row array from `useView`. The hook still reads a local `StoreView`
synchronously; `select` runs against the current rows and `StoreQueryResult`,
and `equality` controls whether equivalent selected values schedule a render.

```tsx
function ItemCount() {
  const count = useViewSelector(itemsQuery, {
    select: (rows) => rows.length,
    equality: Object.is
  }).data;

  return <output>{count}</output>;
}
```

## Imperative subscriptions

Prefer `useView` when Tarstate data drives rendered React output. Use
`useViewSubscription` as the imperative escape hatch when updates should go
straight into something React does not own: canvas or WebGL drawing, animation
loops, chart adapters, virtualized large-data views, or other external targets
where scheduling a React render per store change would be the wrong boundary.

```tsx
function PointsCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useViewSubscription(pointsQuery, {
    fireImmediately: true,
    select: (snapshot) => snapshot.rows,
    onChange: (rows, snapshot) => {
      const canvas = canvasRef.current;
      if (canvas === null) return;
      drawPoints(canvas, rows, snapshot.revision);
    }
  });

  return <canvas ref={canvasRef} />;
}
```

The hook owns the store-view subscription lifecycle, but it does not put selected
data into React state. Keep the rendered tree stable and write from `onChange`
into refs or external objects. Use `select` and `equality` when the target only
needs a derived value or can skip equivalent updates.

`fireImmediately` calls `onChange` once from the effect with the current
snapshot, including after remounts or subscription replacement. Without it, the
callback runs only after a later store-view notification.
