# Ownership and dependency architecture

## Functional-core rule

Pure transformations own Tarstate semantics. Imperative shells own source
lifecycle, subscription, serialization, cancellation, and publication.

The core of a feature should be expressible as values in and values/issues out:
parsing, preparation, projection, query evaluation, maintenance transitions,
diff authoring, reconciliation validation, and state-machine transitions.
Effects execute only after the pure result is complete enough to validate.

Functional style must not hide copying. A pure function may write into explicitly
caller-owned scratch or return retained owned storage when that makes ownership
clear and avoids allocation. Semantic purity means no hidden authority or
externally observable mutation, not “allocate a new object for every step.”

## Lifecycle owner shape

Prefer closures which expose a small frozen protocol over classes and method
binding. A lifecycle owner may retain mutable private scalars, maps, queues, and
listeners when it is the single writer.

`this` is a review smell because methods can be detached, bound repeatedly, or
inherit hidden state. A class is acceptable only when instance branding,
private-field enforcement, or platform interop materially improves the result.
It must not mix domain transformation, I/O, caching, and policy merely because
they share an object.

Current gap: several established lifecycle owners are classes. Future changes
should evaluate them at a natural boundary and convert only where closures
reduce coupling, LOC, or binding hazards. A class-to-closure rewrite with the
same god-object responsibilities is not progress.

## Parse/adopt once

Public boundaries parse or adopt unknown, mutable, or foreign values once.
Owned typed internals do not repeatedly defend against shapes the boundary
already proved. Revalidation is required only after crossing a new authority,
serialization, plugin, worker, source, or mutable-host boundary.

Defensive copies and freezes are ownership tools, not decoration. They belong at
the boundary that acquires an alias; downstream pure functions should not copy
again without a new lifetime reason.

## Dependency direction

The enforced core directions are summarized below. A group may depend on itself
and earlier semantic foundations named by the boundary checker; composition
entries may assemble the complete graph.

```text
foundation
├─ capability ─ artifact resolution
├─ source contract
├─ schema
├─ query model ─ query batch ─ query incremental
├─ transaction model ─ semantic artifacts ─ transaction runtime
├─ attachment runtime
├─ observer contract ─ observer ─ observer incremental
├─ database session
├─ external-store adapter
└─ system/composition
```

This is a direction graph, not a required folder tree. The executable authority
is `scripts/check-boundaries.mjs`.

Satellite direction is one-way:

- Automerge depends on narrow core adapter/source/value topics;
- React depends on public database/query/transaction contracts;
- Zustand depends on the external-store contract;
- schema tools depend on portable artifacts/schema authoring;
- core depends on none of those packages.

## Decouple by authority and volatility

Split a module when parts have different effect authority, owners, change
drivers, public reachability, or test models. Do not split merely because a file
is long.

Strong split signals include:

- pure preparation mixed with a live subscription shell;
- portable model mixed with one adapter implementation;
- query semantics mixed with incremental indexes;
- candidate validation mixed with source publication;
- React observation mixed with database maintenance;
- optional artifact semantics eagerly reachable from the portable catalog;
- one file requiring unrelated context bundles to edit safely.

Weak signals include arbitrary line limits, one-file-per-function, generic
“manager/service/util” layers, or interfaces with only one inseparable owner.

## State and write discipline

Assignment is not inherently bad. Good writes update one owner-controlled
retained state or caller-owned scratch. Bad writes mirror derivable facts,
invalidate broad graphs, mutate borrowed input, or require defensive syncing.

Rules:

- one authoritative writer per mutable cell;
- derive cheap facts instead of caching them;
- cache expensive facts only with explicit identity, invalidation, and lifetime;
- publish immutable snapshots after a transition, never halfway through it;
- use revisions only where they let readers cheaply prove reuse;
- retain arrays/maps on hot paths when identity and capacity are owned;
- avoid broad resets when an exact affected set is available;
- keep canonical index encodings private to the index owner.

## Protocol size

Protocols should name source-neutral facts required by more than one adapter.
Do not create a universal adapter, cache, state-machine, or transaction
interface containing every optional operation. Capabilities should be explicit
and narrow.

Composition roots may know several subsystems; semantic leaves should not.
“Passing one context object everywhere” is hidden coupling even if imports look
clean. Prefer task-specific inputs containing owned facts.

## TypeScript discipline

The repository uses strict TypeScript with `exactOptionalPropertyTypes`,
`noUncheckedIndexedAccess`, `isolatedModules`, `verbatimModuleSyntax`, and
`erasableSyntaxOnly`. Code must remain understandable from the emitted
JavaScript as well as the source types.

Prefer:

- portable const data plus string-literal discriminated unions instead of
  runtime enums;
- `type`-only imports/exports for erased dependencies;
- `unknown` at untrusted boundaries followed by one parser/adopter;
- const type parameters where they preserve authored schema/query literals;
- `satisfies` when checking a value without widening its useful literals;
- targeted `NoInfer` when one argument is the established type authority;
- exhaustive narrowing over closed domain unions;
- branded prepared/owned values only when they prevent a real boundary mix-up.

Avoid namespaces, decorators, parameter properties, runtime TypeScript enums,
unchecked double casts, blanket generic defaults that widen exact evidence, and
overloads that accept semantically different paths under one friendly name.

Readonly types prevent writes through one reference; they do not prove runtime
ownership or prevent another alias from mutating the value. Runtime adoption,
copying, or freezing remains a boundary decision. Conversely, do not add a
runtime brand or freeze solely because TypeScript cannot express a private
implementation detail elegantly.

Type sophistication has a budget. Track compiler types, instantiations, memory,
and allocations; choose a small explicit type or one well-placed consumer cast
over a recursive generic which harms every build.

## Module and API review

Before adding or moving a module, ask:

1. What semantic fact or effect authority does it own?
2. Who creates, observes, and closes it?
3. Which direction may import it?
4. Is its mutable state authoritative or derived?
5. Does the split remove reachable code or context, or only add forwarding?
6. Can its pure behavior be tested without the lifecycle shell?
7. Does it create a second consumer path?

A refactor is successful when it reduces authority overlap, public vocabulary,
reachable code, duplicated facts, or required context—not simply when file
counts rise.
