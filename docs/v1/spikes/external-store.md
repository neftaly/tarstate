# External-store spike evidence

Status: executable evidence, 2026-07-10.

The fixture `packages/zustand/tests/external-store-spike.test.ts` runs the core
`AtomicExternalStore` runtime against Zustand 5.0.14 and TanStack Store 0.11.0.
`@tarstate/zustand` is only a convenience adapter; the Probability-style
TanStack fixture implements the generic protocol directly.

The fixture proves:

- persist middleware hydration remains `loading` until its explicit completion
  signal, including when stored data equals initial state;
- external actions notify synchronously and remain intact after commits;
- compare-and-update produces one store notification, one source notification,
  and one shared revision advance;
- exact stale bases reject;
- two database leases share one runtime and one underlying subscription;
- the last release unsubscribes without closing the borrowed store, and later
  attachment gets a new incarnation;
- a different live store cannot reuse the same source ID; and
- `changed: false` preserves basis and emits nothing.

Direct object mutation changes what the host object returns without a signal or
basis advance. The executable counterexample confirms that such mutation is
outside the protocol; the adapter cannot relabel it as coherent state.

No normative contradiction was found.
