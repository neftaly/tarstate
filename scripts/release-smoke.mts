import type { QueryArtifact, SourceLifecycleCoordinator } from '../packages/core/dist/index.js';
import type { AutomergeAtomicSource } from '../packages/automerge/dist/index.js';
import type { zustandAtomicExternalStore } from '../packages/zustand/dist/index.js';
import type { ReactPreparedPlan } from '../packages/react/dist/index.js';
import type { DatabaseDescription } from '../packages/schema-tools/dist/index.js';

declare const query: QueryArtifact;
declare const lifecycle: SourceLifecycleCoordinator;
declare const automerge: AutomergeAtomicSource<Record<string, unknown>>;
declare const zustand: typeof zustandAtomicExternalStore;
declare const plan: ReactPreparedPlan<unknown, { readonly id: string }>;
declare const description: DatabaseDescription;

void [query, lifecycle, automerge, zustand, plan, description];
