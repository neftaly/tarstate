# @tarstate/react

Small React bindings for consuming Tarstate observers and commits. The provider
borrows database lifecycle; it never closes an externally owned database.
The declared React range is `>=18.3.0 <20`; CI exercises both the minimum 18.3
runtime and the workspace's React 19 version.

Install both Tarstate tarballs and your supported React version:

```sh
npm install \
  ./tarstate-core-0.6.5.tgz \
  ./tarstate-react-0.6.5.tgz \
  react
```

```tsx
import { TarstateProvider, useQuery, useRow } from '@tarstate/react'

const App = () => {
  const names = useQuery(peoplePlan, {
    parameters: { active: true },
    selectSnapshot: snapshot =>
      snapshot.state === 'open' ? snapshot.current.rows.map(row => row.name) : [],
  })
  const selected = useRow(peoplePlan, selectedResultKey)
  return <People names={names} selected={selected} />
}

root.render(
  <TarstateProvider database={database} executeCommit={executeCommit}>
    <App />
  </TarstateProvider>,
)
```

`useQuery` reads current evidence by default. `useRow(..., { readFrom:
'last-exact' })` is the explicit opt-in for retained stale evidence during an
invalidation. `createOptimisticOverlay` may project pending rows for display,
but overlay errors are recorded in `useMutationState` and never decide the
authoritative commit outcome. Row values are generic opaque identities: the
adapter never clones, traverses, or freezes row objects. Live and server
snapshots are borrowed as immutable evidence, while optimistic projection
arrays are copied and frozen. Producers must not mutate a published row while
React can still read it; in-place mutation does not notify React.

For server rendering, pass request/snapshot pairs through
`serverQueryObservations`; the provider does not open a live observer while
rendering a supplied server snapshot.
