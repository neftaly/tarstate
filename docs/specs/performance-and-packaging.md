# Performance, allocation, and packaging

## Priority order

1. Correct semantics, ownership, and bounded work.
2. A small source-neutral model and one consumer path.
3. Appropriate algorithms and incremental invalidation.
4. Low allocation and retained identity on measured hot paths.
5. Engine-specific tuning only with repeatable evidence.

Cleaner ownership commonly improves performance. Microbenchmarks do not justify
public fast paths, duplicated semantics, or obscure code.

## Work model

Preparation may pay once for parsing, canonicalization, dependency analysis,
and index construction. Repeated observation should scale with affected
relations/operators where the maintenance model supports it, not blindly with
the complete dataset.

Important amplification risks are:

- join fan-out and aggregate/window group invalidation;
- repeated canonicalization or hashing inside row loops;
- projecting large unused fields;
- rebuilding relation-key indexes for every operation;
- whole-document conversion at adapter boundaries;
- source-link fixed-point work without exact invalidation or bounds;
- replaying operations under sustained contention without a retry bound.

An optimization must state its complexity in terms meaningful to consumers:
total rows, affected rows, key width, query operators, source count, document
depth/width, or changed bytes.

## Allocation and GC

Hot paths should avoid per-row closures, bound methods, spread chains, temporary
maps/sets, repeated strings, and detached diagnostic objects when retained
storage or a simple loop is clearer.

Prefer:

- stable readonly arrays for unchanged published results;
- retained indexes and scratch owned by one maintenance session;
- numeric or interned internal identities where measurement justifies them;
- one allocation at publication instead of intermediate object pipelines;
- exact affected sets over cloning complete state;
- lazy diagnostic materialization;
- copying once when ownership changes.

Do not retain large backing storage merely to save a small result allocation.
Pool only objects with a clear single owner and reset contract; global pools
couple lifetimes and can retain peak memory indefinitely.

## `Object.freeze`

Freezing is useful for cold boundary-owned configuration and published values
whose immutability is part of the contract. It may cost traversal, allocation,
or engine optimization opportunities when applied repeatedly.

Rules:

- freeze only newly owned containers, never borrowed source objects;
- do not deep-freeze large source snapshots by default;
- avoid freezing transient per-row/per-operator intermediates on hot paths;
- do not freeze as a substitute for clear ownership;
- measure before removing a boundary freeze that prevents aliasing bugs;
- prefer TypeScript readonly plus private ownership internally when runtime
  enforcement adds no boundary value.

## JavaScript-engine discipline

Use engine-friendly code by construction without coding to one JIT:

- stable object shapes and discriminated unions;
- readable indexed/`for…of` loops in hot code;
- no `delete` on retained hot objects;
- no exceptions as ordinary control flow;
- avoid polymorphic callback layers and repeated `.bind()`;
- keep numbers within their declared integer/finite domains;
- avoid megamorphic record access where a prepared field plan is available;
- avoid recursive traversal of hostile input when explicit stacks and budgets
  are safer;
- inspect emitted JavaScript for type-level designs that accidentally add
  runtime enums, decorators, helpers, or class machinery.

Native arrays are the default public result representation. Custom array-like
wrappers require a demonstrated asymptotic or ownership benefit and must not
make common JavaScript operations surprising.

## React performance

React observes stable external-store snapshots. It must not copy rows or rebuild
stores during render. Rendering a query result must not require one independent
subscription per displayed row; `useRow` remains appropriate when a component
independently observes one opaque result occurrence. Selectors and optimistic
overlays should retain identity when their semantic input is unchanged.

Provider updates should be scoped to actual database/plan/parameter changes.
Effects own subscription lifecycle; render remains pure. React-specific memo
layers must not duplicate indexes already owned by query maintenance.

## Tree shaking and optional code

All packages declare no side effects. The core root remains a small foundation;
runtime features use public topic entries. Optional semantic artifact handlers,
incremental maintenance, discovery settlement, framework adapters, and native
source adapters must not become reachable merely because a portable type or
catalog is imported.

Tree shaking is an architecture fitness function, not a reason to create a file
for every function. A new entrypoint is justified when it excludes meaningful
runtime work for a real consumer composition. `scripts/check-tree-shaking.mjs`
measures selected closures against gzip ceilings, including initial-only lazy
boundaries where relevant.

Package boundary checks must also prove that packed duplicate copies preserve
cross-package identity contracts and that satellites import only public narrow
entries.

## Performance evidence

Correctness assertions live inside performance workloads so a fast wrong result
cannot pass. Benchmarks use independent repeated samples and should separate
algorithmic contracts from wall-clock ceilings.

One noisy run on a contended machine is not evidence for code or threshold
changes. A suspected regression should reproduce, isolate the affected
workload, compare a relevant baseline under similar conditions, and profile
before optimization.

Run `pnpm check:perf` for query maintenance or hot-path changes. Targeted
transaction, Automerge, observer, or query benchmarks may supplement it.

## Packaging and release

Tarstate is intentionally distributed as GitHub release tarballs, not npm.
Package manifests remain private unless distribution policy is deliberately
changed later. A release must build and verify all five tarballs in clean
consumer projects and preserve documented topic entrypoints.

Bundle budgets, package exports, README recipes, versions, tags, and tarball
contents are one release contract. No package may rely on monorepo-only source
paths or duplicated dependency identity.
