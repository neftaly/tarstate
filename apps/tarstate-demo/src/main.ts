import { createTarstateDemoSnapshot, type TarstateDemoSnapshot } from './demo.js';
import './style.css';

const app = document.querySelector<HTMLElement>('#app');

if (app === null) {
  throw new Error('Missing #app root');
}

app.textContent = 'Loading Tarstate demo...';

createTarstateDemoSnapshot()
  .then((snapshot) => {
    app.replaceChildren(renderDemo(snapshot));
  })
  .catch((error: unknown) => {
    app.replaceChildren(section('Demo failed', pre(error instanceof Error ? error.message : String(error))));
  });

function renderDemo(snapshot: TarstateDemoSnapshot): HTMLElement {
  const page = element('div', 'page');
  page.append(
    hero(),
    section(
      'Schema',
      table(['Relation', 'Key', 'Fields'], snapshot.schema.map((relation) => [relation.name, relation.key, relation.fields.join(', ')]))
    ),
    section('Source rows', ...relationTables(snapshot.sourceRows, snapshot.schema)),
    section('Query', pre(JSON.stringify(snapshot.query.data, null, 2))),
    section('Query result before writes', todoRowsTable(snapshot.queryResult.rows)),
    section(
      'Writer patch log',
      element('p', 'section-dek', snapshot.writerScenario.description),
      table(
        ['Step', 'Op', 'Relation', 'Intent', 'Patch'],
        snapshot.patchLog.map((entry) => [String(entry.index), entry.op, entry.relation, entry.intent, entry.summary])
      ),
      statusLine(`${snapshot.writeResult.applied}/${snapshot.writeResult.patches} patches applied`)
    ),
    section('Resulting snapshot after writes', ...relationTables(snapshot.nextRows, snapshot.schema)),
    section('Query result after writes', todoRowsTable(snapshot.nextQueryResult.rows))
  );

  return page;
}

function hero(): HTMLElement {
  const header = element('header', 'hero');
  header.append(element('p', 'eyebrow', 'Tarstate demo v2'), element('h1', undefined, 'Todo queries and writer patches'), element('p', 'dek', 'A small DOM app showing source relation rows, the query result, an ordered writer batch, and the resulting snapshot after writes.'));
  return header;
}

function section(title: string, ...children: readonly HTMLElement[]): HTMLElement {
  const wrapper = element('section', 'panel');
  wrapper.append(element('h2', undefined, title), ...children);
  return wrapper;
}

function table(headers: readonly string[], rows: readonly (readonly string[])[]): HTMLElement {
  const tableElement = document.createElement('table');
  const thead = document.createElement('thead');
  const tbody = document.createElement('tbody');

  const headerRow = document.createElement('tr');
  for (const header of headers) headerRow.append(element('th', undefined, header));
  thead.append(headerRow);

  for (const row of rows) {
    const rowElement = document.createElement('tr');
    for (const cell of row) rowElement.append(element('td', undefined, cell));
    tbody.append(rowElement);
  }

  tableElement.append(thead, tbody);
  return tableElement;
}

function relationTables(
  rowsByRelation: TarstateDemoSnapshot['sourceRows'],
  schema: TarstateDemoSnapshot['schema']
): readonly HTMLElement[] {
  return schema.map((relation) => {
    const group = element('div', 'relation-group');
    const rows = rowsByRelation[relation.name] ?? [];
    group.append(
      element('h3', undefined, `${relation.name} (${rows.length})`),
      table(relation.fields, rows.map((row) => relation.fields.map((field) => formatRowValue(row, field))))
    );
    return group;
  });
}

function todoRowsTable(rows: TarstateDemoSnapshot['queryResult']['rows']): HTMLElement {
  return table(
    ['id', 'text', 'done', 'writer'],
    rows.map((row) => [row.id, row.text, formatValue(row.done), formatValue(row.writer)])
  );
}

function pre(content: string): HTMLPreElement {
  const preElement = document.createElement('pre');
  preElement.textContent = content;
  return preElement;
}

function statusLine(content: string): HTMLElement {
  return element('p', 'status', content);
}

function formatRowValue(row: unknown, field: string): string {
  if (row === null || typeof row !== 'object' || !Object.hasOwn(row, field)) {
    return '';
  }

  return formatValue((row as Record<string, unknown>)[field]);
}

function formatValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function element<TagName extends keyof HTMLElementTagNameMap>(
  tagName: TagName,
  className?: string,
  textContent?: string
): HTMLElementTagNameMap[TagName] {
  const node = document.createElement(tagName);
  if (className !== undefined) node.className = className;
  if (textContent !== undefined) node.textContent = textContent;
  return node;
}
