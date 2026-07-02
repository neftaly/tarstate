import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import {
  RealEstateApp,
  RealEstateWalkthrough,
  apiExamples,
  createRealEstateModel
} from './demo.js';

describe('Tarstate API walkthrough demo', () => {
  it('documents the final app-facing API decisions', () => {
    expect(apiExamples.map((example) => example.id)).toEqual([
      'q',
      'qResult',
      'provider',
      'hooks'
    ]);

    const snippets = apiExamples.map((example) => example.source).join('\n');
    expect(snippets).toContain('q(db, listingRowsQuery)');
    expect(snippets).toContain('qResult(db, listingRowsQuery)');
    expect(snippets).toContain('initialDb={seedRows}');
    expect(snippets).toContain('useView(listingRowsQuery)');
    expect(snippets).toContain('}).data');
    expect(snippets).not.toContain('qRows');
    expect(snippets).not.toContain('qManyRows');
    expect(snippets).not.toContain('<TarstateProvider db=');
    expect(snippets).not.toContain('.status');
    expect(snippets).not.toContain('.view');
    expect(snippets).not.toContain('.snapshot');
  });

  it('keeps only a minimal provider-seeded app shell', async () => {
    const model = createRealEstateModel();
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(createElement(RealEstateApp, { model }));
    });

    expect(renderer?.root.findAllByProps({ 'data-demo': 'RealEstateWalkthrough' })).toHaveLength(1);
    expect(sectionIds(renderer)).toEqual(['q', 'qResult', 'provider', 'hooks']);
  });

  it('can render the walkthrough without runtime setup', async () => {
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(createElement(RealEstateWalkthrough));
    });

    expect(sectionIds(renderer)).toEqual(['q', 'qResult', 'provider', 'hooks']);
  });
});

function sectionIds(renderer: ReactTestRenderer | undefined): readonly string[] {
  if (renderer === undefined) return [];
  return renderer.root
    .findAll((node) => typeof node.props['data-section'] === 'string')
    .map((node) => String(node.props['data-section']));
}
