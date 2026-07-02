import { createElement, type ReactElement } from 'react';
import { TarstateProvider } from '@tarstate/react';

export type ApiExampleId =
  | 'q'
  | 'qResult'
  | 'provider'
  | 'hooks';

export type ApiExample = {
  readonly id: ApiExampleId;
  readonly title: string;
  readonly summary: string;
  readonly source: string;
};

export type RealEstateModel = {
  readonly initialDb: {
    readonly properties: readonly [];
    readonly offers: readonly [];
    readonly decisions: readonly [];
  };
};

export const apiExamples: readonly ApiExample[] = [
  {
    id: 'q',
    title: 'Rows-first reads',
    summary: 'q returns rows directly for app reads.',
    source: `import { q } from '@tarstate/core/db';

const rows = q(db, listingRowsQuery);`
  },
  {
    id: 'qResult',
    title: 'Diagnostics envelope',
    summary: 'qResult keeps diagnostics available when a caller needs them.',
    source: `import { qResult } from '@tarstate/core/db';

const { rows, diagnostics } = qResult(db, listingRowsQuery);`
  },
  {
    id: 'provider',
    title: 'React provider seed',
    summary: 'The provider seed prop is explicit about one-time initialization.',
    source: `<TarstateProvider initialDb={seedRows}>
  <Listings />
</TarstateProvider>`
  },
  {
    id: 'hooks',
    title: 'Slim hook state',
    summary: 'React hooks expose app-facing read state without store internals.',
    source: `const listings = useView(listingRowsQuery);
const rows = listings.rows;
const revision = listings.revision;

const agentNames = useQuery(agentRowsQuery, {
  select: (rows) => rows.map((row) => row.agentName)
}).data;`
  }
];

export function createRealEstateModel(): RealEstateModel {
  return {
    initialDb: {
      properties: [],
      offers: [],
      decisions: []
    }
  };
}

export function RealEstateApp({
  model = createRealEstateModel()
}: {
  readonly model?: RealEstateModel;
}): ReactElement {
  return createElement(
    TarstateProvider,
    { initialDb: model.initialDb },
    createElement(RealEstateWalkthrough)
  );
}

export function RealEstateWalkthrough(): ReactElement {
  return createElement(
    'main',
    { className: 'page', 'data-demo': 'RealEstateWalkthrough' },
    createElement('header', { className: 'page-title' },
      createElement('h1', null, 'Tarstate API walkthrough'),
      createElement('p', null, 'Small examples for the rows-first API surface.')
    ),
    ...apiExamples.map((example) => createElement(
      'section',
      { key: example.id, className: 'panel', 'data-section': example.id },
      createElement('div', { className: 'section-head' },
        createElement('h2', null, example.title),
        createElement('p', null, example.summary)
      ),
      createElement('pre', { className: 'snippet' },
        createElement('code', null, example.source)
      )
    ))
  );
}
