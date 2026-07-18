# @tarstate/zustand

The official thin Zustand adapter for Tarstate's generic atomic external-store
protocol.

Adapted stores must contain plain data state. Tarstate replacements use
Zustand's replace mode, so action functions should remain outside the adapted
state object.

Install both Tarstate tarballs and the Zustand package imported by application
code:

```sh
npm install \
  ./tarstate-core-0.4.9.tgz \
  ./tarstate-zustand-0.4.9.tgz \
  zustand
```

## Usage

Adapt a vanilla Zustand store, then acquire one host-owned Tarstate runtime for
that store identity:

```ts
import { HostRuntimeRegistry, acquireExternalStoreRuntime } from '@tarstate/core/database/external-store';
import { zustandAtomicExternalStore } from '@tarstate/zustand';
import { createStore } from 'zustand/vanilla';

type State = { readonly selectedId: string | null };

const store = createStore<State>(() => ({ selectedId: null }));
const host = new HostRuntimeRegistry({ trustPolicyId: 'app' });
const lease = acquireExternalStoreRuntime({
  registry: host,
  sourceId: 'source:selection',
  store: zustandAtomicExternalStore(store),
  storeIdentity: store
});

const before = lease.runtime.snapshot();
const receipt = lease.runtime.commit(before.basis, state => ({
  state: { ...state, selectedId: 'item:one' },
  changed: state.selectedId !== 'item:one',
  result: undefined
}));

console.log(receipt.outcome, lease.runtime.snapshot().storage);
lease.release();
host.close();
```

Pass `store.persist` as `hydration` when using Zustand's `persist` middleware:
`zustandAtomicExternalStore(store, { hydration: store.persist })`. The runtime
reports loading evidence until hydration finishes. Always release the runtime
lease; the host registry deduplicates acquisitions by `sourceId` and store
identity.
