# Query semantics

## One semantic language

Queries are portable values. Typed builders, untyped builders, batch
evaluation, incremental maintenance, database sessions, React hooks, and
constraint queries must interpret the same query model.

The typed API is an authoring layer over that model, not a second evaluator.
The exhaustive AST remains the advanced escape hatch; adding a friendly helper
must not add a runtime branch or a second operator meaning.

## Relation input

A relation input is identified by an exact schema view and stable relation ID.
Rows carry portable logical values, exact logical keys where available, source
identity, completeness, and issues through the containing evaluation context.

Consumers must not join relations merely because their human-readable names
match. Schema view and relation identity are semantic evidence.

## Expressions

Expressions distinguish literals, parameters, fields, keys, source identity,
comparisons, boolean logic, null/missing tests, named capabilities, and bounded
subqueries. Unknown or unavailable inputs propagate according to logical
semantics; they are not JavaScript truthiness.

Named calls resolve only through a prepared capability registry and authority
view. A query value cannot supply executable JavaScript.

Parameters are parsed once against exact declarations before evaluation. Extra,
missing, or invalid parameters report issues rather than widening the query.

## Operators

The portable language currently supports relation and constant sources,
filtering, selection, field extension/rename/omit, unnesting, joins, aggregates,
distinct, set operations, ordering, slicing, and windows.

Operator contracts include:

- deterministic result rows and result keys for equal prepared input;
- explicit null, missing, unknown, and completeness behavior;
- exact alias ownership so fields do not collide silently;
- stable ordering only where order is requested or semantically required;
- bounded work and structured issues on exhaustion;
- no dependence on object enumeration order for relational meaning.

A new operator is justified only by a common relational task or a material
correctness/performance capability that composition cannot express cleanly.
SQL feature parity is not a goal.

## Preparation

Preparation parses and owns the query, resolves schema and capabilities, checks
aliases and fields, derives dependencies and projection demand, and binds an
explicit registry/authority/dataset scope. Prepared plans are immutable
semantic evidence and carry typed row/parameter brands without runtime type
branches.

The scope fingerprint prevents accidental reuse under a different authority or
dataset. Preparation must not capture live source state.

## Batch evaluation

Batch evaluation is the reference semantic path. It is pure over a prepared
plan, relation inputs, parameters, capability implementations, and a work
budget. It returns rows, result keys, completeness, and issues.

Inputs and outputs are readonly. The evaluator may reuse internal owned storage
only when the published result cannot subsequently change.

## Incremental maintenance

Incremental maintenance is an optimization of batch semantics. Given an exact
previous state and a valid relation delta, its observable result must match
fresh batch evaluation at the same logical state.

The engine may maintain indexes, join/aggregate/window state, dependency maps,
and pooled storage privately. These are not public APIs and must not be required
from a host. Unsupported, incomplete, or unsafe transitions fall back
explicitly; they must not return a plausible but wrong exact result.

Work sharing may reuse prepared structure and maintenance state across queries
only when authority, dataset, parameters, and lifetime permit it. Closing one
consumer must not invalidate another consumer's retained result.

## Projection demand

Preparation derives which relation fields can affect a result. Database
adapters may use this demand to avoid projecting or invalidating unused large
fields. Field pruning must preserve keys, source identity, constraints, query
capabilities, and any field whose absence could change completeness or an
issue.

Demand analysis is conservative: false positives cost work; false negatives
are correctness defects. An update to an unobserved field should reuse the
logical projection and query result when source evidence proves it cannot
affect either.

## Ordering and identity

Relational equality uses portable semantic equality, not JavaScript reference
identity. Ordering is deterministic across supported runtimes for portable
values. Composite keys retain declared field order.

Result keys identify output occurrences for observation/UI reconciliation.
They must change when the semantic occurrence changes and remain stable across
updates that preserve it. Result-array reference reuse is permitted and useful,
but result keys are the semantic identity contract.

## Query adversarial review

Review changes against:

- batch/incremental differential equivalence;
- incomplete or unknown inputs and fallback correctness;
- join fan-out and aggregate/window invalidation amplification;
- deterministic order and duplicate occurrences;
- parameter and capability authority changes;
- field-dependency false negatives;
- allocation per affected row versus per total dataset;
- compiler/type-instantiation growth in typed authoring;
- public helpers that duplicate existing composition.
