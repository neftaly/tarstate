# Pure semantic spike evidence

Status: executable evidence, 2026-07-10.

The isolated `@tarstate/core/v1-spike` evaluator consumes the query and
expression discriminants from the spike wire contract. The conformance fixture
is `packages/core/tests/v1-pure-spike.test.ts`.

The fixture proves:

- reconstruction of every frozen built-in capability hash from its canonical
  declaration;
- the complete strong Kleene `and`, `or`, and `not` tables;
- missing-field omission versus explicit `null` preservation;
- bag multiplicity through inner joins;
- lower-bound results for positive monotone operators;
- unknown, empty-current results for anti-join and aggregate over incomplete
  evidence; and
- grouped count, field count, distinct count, and empty global grouping.

No contradiction with the normative truth or completeness tables was found.
The evaluator is deliberately isolated evidence, not a compatibility wrapper
around the legacy query implementation.
