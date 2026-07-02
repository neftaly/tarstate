import { createElement, type ReactElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { qRows, readMaterializedQuery, type Store } from '@tarstate/core';
import { TarstateProvider } from '@tarstate/react';
import {
  RealEstateApp,
  RealEstateWalkthrough,
  acceptedSalesQuery,
  areaCode,
  commissionDueQuery,
  createAutomergeRealEstateBacking,
  createRealEstateDb,
  createRealEstateModel,
  createRealEstateStore,
  currentOffersQuery,
  listingRowsQuery,
  openOffersQuery,
  priceBand,
  propertyInfoQuery,
  readableDiagnostics,
  realEstateSchema,
  runAcceptHarbourOfferTransaction,
  runAddMillOfferTransaction,
  runAutomergeListingRows,
  runInvalidOfferAfterAcceptedTransaction,
  runPlaygroundQuery,
  runRejectGardenLatestTransaction,
  saleSpeed,
  seedRealEstateData,
  type RealEstateModel
} from './demo.js';

describe('Relic-style real-estate demo', () => {
  it('exports the fixed real-estate schema, seed data, and helper semantics', () => {
    expect(Object.keys(realEstateSchema)).toEqual([
      'agents',
      'buyers',
      'properties',
      'rooms',
      'offers',
      'decisions',
      'commissionRates'
    ]);
    expect(seedRealEstateData()).toMatchObject({
      agents: [
        { id: 'agent-rose', name: 'Rose Patel' },
        { id: 'agent-bob', name: 'Bob Stone' },
        { id: 'agent-uma', name: 'Uma Reid' }
      ],
      properties: [
        { id: 'property-elm', address: '12 Elm Street 55', price: 344000, areaCode: '55', priceBand: 'med' },
        { id: 'property-harbour', address: '7 Harbour View 42', price: 920000, areaCode: '42', priceBand: 'high' },
        { id: 'property-mill', address: '3 Mill Lane 17', price: 1690000, areaCode: '17', priceBand: 'premium' },
        { id: 'property-garden', address: '18 Garden Road 55', price: 610000, areaCode: '55', priceBand: 'med' }
      ],
      offers: [
        { id: 'offer-elm-alice-1', amount: 330000 },
        { id: 'offer-elm-alice-2', amount: 343000 },
        { id: 'offer-harbour-mia-1', amount: 900000 },
        { id: 'offer-garden-nico-1', amount: 595000 },
        { id: 'offer-garden-nico-2', amount: 612000 }
      ]
    });
    expect(priceBand(300000)).toBe('low');
    expect(priceBand(344000)).toBe('med');
    expect(priceBand(920000)).toBe('high');
    expect(priceBand(1690000)).toBe('premium');
    expect(areaCode('42 Wonderland 42')).toBe('42');
    expect(saleSpeed('2021-10-11', '2021-11-05')).toBe('medium');
  });

  it.skip('runs exported real-estate query values over the object DB', () => {
    const state = createRealEstateDb();

    expect(qRows(state, propertyInfoQuery)).toMatchObject([
      { id: 'property-elm', agentName: 'Rose Patel', roomCount: 2, squareFeet: 156, priceBand: 'med', areaCode: '55' },
      { id: 'property-garden', agentName: 'Uma Reid', roomCount: 3, squareFeet: 355, priceBand: 'med', areaCode: '55' },
      { id: 'property-harbour', agentName: 'Bob Stone', roomCount: 3, squareFeet: 384, priceBand: 'high', areaCode: '42' },
      { id: 'property-mill', agentName: 'Bob Stone', roomCount: 3, squareFeet: 860, priceBand: 'premium', areaCode: '17' }
    ]);
    expect(qRows(state, currentOffersQuery)).toMatchObject([
      { id: 'offer-elm-alice-2', buyerName: 'Alice Hart', amount: 343000, decisionId: 'decision-elm-accepted' },
      { id: 'offer-garden-nico-2', buyerName: 'Nico Ford', amount: 612000, decisionId: undefined },
      { id: 'offer-harbour-mia-1', buyerName: 'Mia Chen', amount: 900000, decisionId: undefined }
    ]);
    expect(qRows(state, acceptedSalesQuery)).toEqual([
      expect.objectContaining({
        id: 'decision-elm-accepted',
        propertyId: 'property-elm',
        buyerName: 'Alice Hart',
        agentName: 'Rose Patel',
        amount: 343000,
        priceBand: 'med',
        saleSpeed: 'very-fast',
        listingState: 'sold'
      })
    ]);
    expect(qRows(state, listingRowsQuery)).toMatchObject([
      { id: 'property-garden', listingState: 'listed' },
      { id: 'property-harbour', listingState: 'listed' },
      { id: 'property-mill', listingState: 'listed' }
    ]);
    expect(qRows(state, openOffersQuery)).toMatchObject([
      { id: 'offer-garden-nico-2', decisionStatus: 'open' },
      { id: 'offer-harbour-mia-1', decisionStatus: 'open' }
    ]);
    expect(qRows(state, commissionDueQuery)).toEqual([
      { id: 'agent-rose', agentId: 'agent-rose', agentName: 'Rose Patel', sales: 1, saleVolume: 343000, commissionDue: 2000 }
    ]);
  });

  it.skip('applies query playground filters through env-backed query values', () => {
    const state = createRealEstateDb();

    expect(ids(runPlaygroundQuery(state, 'propertyInfo', { agentId: 'agent-bob' }))).toEqual([
      'property-harbour',
      'property-mill'
    ]);
    expect(ids(runPlaygroundQuery(state, 'propertyInfo', { areaCode: '55' }))).toEqual([
      'property-elm',
      'property-garden'
    ]);
    expect(ids(runPlaygroundQuery(state, 'propertyInfo', { priceBand: 'med' }))).toEqual([
      'property-elm',
      'property-garden'
    ]);
    expect(ids(runPlaygroundQuery(state, 'currentOffers', { buyerId: 'buyer-mia' }))).toEqual([
      'offer-harbour-mia-1'
    ]);
    expect(ids(runPlaygroundQuery(state, 'listingRows', { minPrice: 600000, maxPrice: 1000000 }))).toEqual([
      'property-garden',
      'property-harbour'
    ]);
    expect(ids(runPlaygroundQuery(state, 'acceptedSales', { listingState: 'listed' }))).toEqual([]);
    expect(ids(runPlaygroundQuery(state, 'acceptedSales', { listingState: 'sold' }))).toEqual([
      'decision-elm-accepted'
    ]);
  });

  it.skip('materializes listing rows and commission due', async () => {
    const store = await createRealEstateStore();

    expect(readMaterializedQuery(store.getSnapshot().db, listingRowsQuery)).toMatchObject({
      materialized: true,
      rows: [
        expect.objectContaining({ id: 'property-garden' }),
        expect.objectContaining({ id: 'property-harbour' }),
        expect.objectContaining({ id: 'property-mill' })
      ]
    });
    expect(readMaterializedQuery(store.getSnapshot().db, commissionDueQuery)).toMatchObject({
      materialized: true,
      rows: [
        { id: 'agent-rose', agentId: 'agent-rose', agentName: 'Rose Patel', sales: 1, saleVolume: 343000, commissionDue: 2000 }
      ]
    });
  });

  it.skip('commits real-estate transactions and rejects invalid writes with diagnostics', async () => {
    const store = await createRealEstateStore();

    await expect(runAddMillOfferTransaction(store)).resolves.toMatchObject({
      status: 'accepted',
      reflected: true,
      effects: { patches: 1, applied: 1 },
      snapshot: { revision: 1 }
    });
    expect(store.view(openOffersQuery).getSnapshot().rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'offer-mill-mia-1' })
    ]));

    await expect(runRejectGardenLatestTransaction(store)).resolves.toMatchObject({
      status: 'accepted',
      reflected: true,
      effects: { patches: 1, applied: 1 },
      snapshot: { revision: 2 }
    });
    expect(store.view(openOffersQuery).read().rows).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'offer-garden-nico-2' })
    ]));

    await expect(runAcceptHarbourOfferTransaction(store)).resolves.toMatchObject({
      status: 'accepted',
      reflected: true,
      effects: { patches: 1, applied: 1 },
      snapshot: { revision: 3 }
    });
    expect(store.view(listingRowsQuery).getSnapshot().rows).toMatchObject([
      { id: 'property-garden' },
      { id: 'property-mill' }
    ]);
    expect(store.query(commissionDueQuery)).toMatchObject({
      rows: expect.arrayContaining([
      { id: 'agent-bob', agentId: 'agent-bob', agentName: 'Bob Stone', sales: 1, saleVolume: 900000, commissionDue: 4500 }
      ])
    });

    const invalid = await runInvalidOfferAfterAcceptedTransaction(store);
    expect(invalid.status).toBe('rejected');
    expect(invalid.reflected).toBe(false);
    expect(invalid.effects.applied).toBe(0);
    expect(invalid.snapshot.revision).toBe(3);
    expect(readableDiagnostics(invalid.diagnostics)).toContainEqual(expect.objectContaining({
      code: 'constraint_check',
      field: 'amount'
    }));
  });

  it.skip('runs listing rows over an Automerge-backed snapshot', async () => {
    const backing = createAutomergeRealEstateBacking();

    await expect(runAutomergeListingRows(backing)).resolves.toMatchObject([
      { id: 'property-garden' },
      { id: 'property-harbour' },
      { id: 'property-mill' }
    ]);
  });

  it.skip('renders controls, live transactions, diagnostics, watch output, and Automerge output', async () => {
    const model = await createRealEstateModel();
    const renderer = await renderApp(model);

    await waitFor(() => {
      expect(sectionIds(renderer)).toEqual([
        'facts',
        'playground',
        'materialized',
        'transactions',
        'diagnostics',
        'watch',
        'automerge'
      ]);
      expect(tableRowIds(renderer, 'playground')).toEqual([
        'property-elm',
        'property-garden',
        'property-harbour',
        'property-mill'
      ]);
    });

    await changeControl(renderer, 'agent', 'agent-bob');
    await waitFor(() => {
      expect(tableRowIds(renderer, 'playground')).toEqual(['property-harbour', 'property-mill']);
    });

    await changeControl(renderer, 'query', 'listingRows');
    await waitFor(() => {
      expect(tableRowIds(renderer, 'playground')).toEqual(['property-harbour', 'property-mill']);
    });

    await click(renderer, 'accept-harbour');
    await waitFor(() => {
      expect(tableRowIds(renderer, 'playground')).toEqual(['property-mill']);
      expect(tableRowIds(renderer, 'materialized-listings')).toEqual(['property-garden', 'property-mill']);
      expect(metric(renderer, 'Watch removed')).toBe('property-harbour');
    });

    await click(renderer, 'invalid-offer');
    await waitFor(() => {
      expect(diagnosticCodes(renderer)).toContain('constraint_check');
    });

    await click(renderer, 'run-automerge');
    await waitFor(() => {
      expect(metric(renderer, 'Automerge rows')).toBe('3: property-garden, property-harbour, property-mill');
    });
  });

  it('exports one provider-scoped app for the browser entry', async () => {
    const model = await createRealEstateModel();
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(createElement(RealEstateApp, { model }));
    });

    expect(renderer?.root.findAllByProps({ 'data-demo': 'RealEstateWalkthrough' })).toHaveLength(1);
  });
});

async function renderApp(model: RealEstateModel): Promise<ReactTestRenderer> {
  return renderWithProvider(model.store, createElement(RealEstateWalkthrough, { automerge: model.automerge }));
}

async function renderWithProvider(
  store: Store,
  child: ReactElement
): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(createElement(TarstateProvider, { store }, child));
  });
  if (renderer === undefined) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

async function changeControl(renderer: ReactTestRenderer, control: string, value: string): Promise<void> {
  const node = renderer.root.findByProps({ 'data-control': control });
  await act(async () => {
    node.props.onChange({ target: { value } });
  });
}

async function click(renderer: ReactTestRenderer, action: string): Promise<void> {
  const button = renderer.root.findByProps({ 'data-action': action });
  await act(async () => {
    await button.props.onClick();
  });
}

function ids(rows: readonly { readonly id: string }[]): readonly string[] {
  return rows.map((row) => row.id);
}

function sectionIds(renderer: ReactTestRenderer): readonly string[] {
  return renderer.root
    .findAll((node) => typeof node.props['data-section'] === 'string')
    .map((node) => String(node.props['data-section']));
}

function tableRowIds(renderer: ReactTestRenderer, table: string): readonly string[] {
  const tableNode = renderer.root.findByProps({ 'data-table': table });
  return tableNode
    .findAll((node) => typeof node.props['data-row-id'] === 'string')
    .map((node) => String(node.props['data-row-id']));
}

function metric(renderer: ReactTestRenderer, label: string): string {
  const node = renderer.root.findByProps({ 'data-metric': label });
  return textContentDeep(node.findByType('strong'));
}

function diagnosticCodes(renderer: ReactTestRenderer): readonly string[] {
  return renderer.root
    .findAll((node) => typeof node.props['data-diagnostic-code'] === 'string')
    .map((node) => String(node.props['data-diagnostic-code']));
}

function textContentDeep(node: { readonly children: readonly unknown[] }): string {
  return node.children.map((child) => {
    if (typeof child === 'string' || typeof child === 'number') return String(child);
    if (isRendererNode(child)) return textContentDeep(child);
    return '';
  }).join('');
}

function isRendererNode(input: unknown): input is { readonly children: readonly unknown[] } {
  return typeof input === 'object' && input !== null && Array.isArray((input as { readonly children?: unknown }).children);
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }
  throw lastError;
}
