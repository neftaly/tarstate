import type { QueryArtifact } from '../packages/core/dist/query/authoring/index.js';
import type { SourceLifecycleCoordinator } from '../packages/core/dist/transactions/index.js';
import type { Artifact as TopicArtifact } from '../packages/core/dist/artifacts/index.js';
import type { DatabaseView as TopicDatabaseView } from '../packages/core/dist/database/index.js';
import type { ObserverDiagnosticReporter as TopicObserverDiagnosticReporter } from '../packages/core/dist/database/index.js';
import type { QueryNode as TopicQueryNode } from '../packages/core/dist/query/index.js';
import type { PreparedPlan as TopicPreparedPlan } from '../packages/core/dist/query/index.js';
import type { SchemaBody as TopicSchemaBody } from '../packages/core/dist/schema/index.js';
import type { Transaction as TopicTransaction } from '../packages/core/dist/transactions/index.js';
import type { AutomergeAttachment } from '../packages/automerge/dist/index.js';
import type { zustandAtomicExternalStore } from '../packages/zustand/dist/index.js';
import type { ReactPreparedPlan } from '../packages/react/dist/index.js';
import type { DatabaseDescription } from '../packages/schema-tools/dist/index.js';

declare const query: QueryArtifact;
declare const lifecycle: SourceLifecycleCoordinator;
declare const automerge: AutomergeAttachment;
declare const zustand: typeof zustandAtomicExternalStore;
declare const plan: ReactPreparedPlan<unknown, { readonly id: string }>;
declare const description: DatabaseDescription;
declare const topicSurface: readonly [TopicArtifact, TopicDatabaseView<unknown, unknown>, TopicObserverDiagnosticReporter, TopicQueryNode, TopicPreparedPlan, TopicSchemaBody, TopicTransaction];

void [query, lifecycle, automerge, zustand, plan, description, topicSurface];
