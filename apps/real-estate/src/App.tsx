import { useMemo, useState, type ReactNode } from 'react';
import { insert, updateByKey } from '@tarstate/core/write';
import { TarstateProvider, useDb, useRow, useTarstateMutation, useTarstateSnapshot, useView } from '@tarstate/react';
import { listingStatuses, neighborhoods, schema, type InquiryStatus, type ListingStatus } from './domain';
import {
  allListingsQuery,
  defaultListingFilters,
  inquiryQueueQuery,
  listingListQuery,
  marketSummaryQuery,
  offerBookQuery,
  pipelineByListingQuery,
  viewingScheduleQuery,
  type ListingFilters
} from './queries';
import { createRealEstateStore } from './store';

type Column<Row> = readonly [heading: string, render: (row: Row) => ReactNode];

const currency = new Intl.NumberFormat('en-US', { currency: 'USD', maximumFractionDigits: 0, style: 'currency' });
const demoDate = '2026-07-06';
const initialListingId = 'listing-oak-101';
const relationNames = ['neighborhoods', 'agents', 'listings', 'viewings', 'inquiries', 'offers'] as const;

export function App() {
  const store = useMemo(() => createRealEstateStore(), []);
  const [selectedListingId, setSelectedListingId] = useState(initialListingId);

  return (
    <TarstateProvider store={store}>
      <main className="app">
        <header className="page-header">
          <h1>Tarstate real estate example</h1>
          <p>A small React app with normalized relations, query-derived views, and write actions.</p>
        </header>
        <DatabaseOverview />
        <ListingBrowser selectedListingId={selectedListingId} onSelectListing={setSelectedListingId} />
        <SelectedListing selectedListingId={selectedListingId} />
        <DerivedViews />
        <WriteActions selectedListingId={selectedListingId} onSelectListing={setSelectedListingId} />
      </main>
    </TarstateProvider>
  );
}

function DatabaseOverview() {
  const db = useDb();
  const snapshot = useTarstateSnapshot();
  const rows = relationNames.map((name) => ({ name, count: db.data[name]?.length ?? 0 }));

  return (
    <section>
      <h2>Provider and snapshot</h2>
      <p className="note">TarstateProvider supplies the store. useDb and useTarstateSnapshot read the current revision.</p>
      <Summary items={[['revision', snapshot.revision], ['relations', rows.length]]} />
      <Table rows={rows} rowKey={(row) => row.name} columns={[['Relation', (row) => row.name], ['Rows', (row) => row.count]]} />
    </section>
  );
}

function ListingBrowser({
  selectedListingId,
  onSelectListing
}: {
  readonly selectedListingId: string;
  readonly onSelectListing: (id: string) => void;
}) {
  const [filters, setFilters] = useState<ListingFilters>(defaultListingFilters);
  const query = useMemo(() => listingListQuery(filters), [filters]);
  const listingView = useView(query, { resetKey: JSON.stringify(filters) });
  const update = <Key extends keyof ListingFilters>(key: Key, value: ListingFilters[Key]) =>
    setFilters((current) => ({ ...current, [key]: value }));
  const updateStatusFilter = (value: string) => {
    const status = parseListingStatusFilter(value);
    if (status !== undefined) update('status', status);
  };
  const updateNeighborhoodFilter = (value: string) => {
    const neighborhoodId = parseNeighborhoodFilter(value);
    if (neighborhoodId !== undefined) update('neighborhoodId', neighborhoodId);
  };

  return (
    <section>
      <h2>Filtered listings</h2>
      <p className="note">useView renders a join across listings, agents, and neighborhoods with live filters.</p>
      <fieldset>
        <legend>Filters</legend>
        <Labeled label="Status">
          <select value={filters.status} onChange={(event) => updateStatusFilter(event.target.value)}>
            <option value="all">All</option>
            {listingStatuses.map((status) => <option key={status} value={status}>{formatStatus(status)}</option>)}
          </select>
        </Labeled>
        <Labeled label="Neighborhood">
          <select value={filters.neighborhoodId} onChange={(event) => updateNeighborhoodFilter(event.target.value)}>
            <option value="all">All</option>
            {neighborhoods.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </Labeled>
        <NumberFilter label="Minimum beds" value={filters.minBeds} min={0} max={5} onChange={(value) => update('minBeds', value)} />
        <NumberFilter
          label="Maximum price"
          value={filters.maxPrice}
          min={300000}
          step={25000}
          onChange={(value) => update('maxPrice', value)}
        />
      </fieldset>
      <Table
        rows={listingView.rows}
        rowKey={(row) => row.id}
        empty="No listings match the current filters."
        rowClass={(row) => row.id === selectedListingId ? 'selected-row' : undefined}
        columns={[
          ['Address', (row) => row.address],
          ['Neighborhood', (row) => row.neighborhoodName],
          ['Agent', (row) => row.agentName],
          ['Price', (row) => money(row.price)],
          ['Beds', (row) => row.beds],
          ['Status', (row) => formatStatus(row.status)],
          ['Action', (row) => <button type="button" onClick={() => onSelectListing(row.id)}>Select</button>]
        ]}
      />
    </section>
  );
}

function SelectedListing({ selectedListingId }: { readonly selectedListingId: string }) {
  const listingState = useRow(schema.listings, selectedListingId);
  const row = listingState.row;

  return (
    <section>
      <h2>Selected listing</h2>
      {row === undefined ? (
        <p>Listing not found.</p>
      ) : (
        <>
          <p className="note">useRow reads one normalized listing row by relation key.</p>
          <Summary items={[['address', row.address], ['price', money(row.price)], ['status', formatStatus(row.status)], ['view revision', listingState.revision]]} />
        </>
      )}
    </section>
  );
}

function DerivedViews() {
  const market = useView(marketSummaryQuery);
  const pipeline = useView(pipelineByListingQuery);
  const viewings = useView(viewingScheduleQuery);
  const inquiries = useView(inquiryQueueQuery);
  const offers = useView(offerBookQuery);

  return (
    <section>
      <h2>Derived views</h2>
      <p className="note">These useView calls read joined and aggregated queries.</p>
      <ViewTable
        title="Neighborhood aggregation"
        rows={market.rows}
        rowKey={(row) => row.neighborhoodId}
        columns={[
          ['Neighborhood', (row) => row.neighborhoodName],
          ['Listings', (row) => countText(row.listingCount)],
          ['Active', (row) => countText(row.activeCount)],
          ['Average price', (row) => money(row.averagePrice)],
          ['Highest price', (row) => money(row.highestPrice)]
        ]}
      />
      <ViewTable
        title="Listing pipeline"
        rows={pipeline.rows}
        rowKey={(row) => row.listingId}
        columns={[
          ['Listing', (row) => row.address],
          ['Agent', (row) => row.agentName],
          ['Inquiries', (row) => countText(row.inquiryCount)],
          ['Qualified', (row) => countText(row.qualifiedInquiries)],
          ['Offers', (row) => countText(row.offerCount)],
          ['Top offer', (row) => money(row.topOffer)]
        ]}
      />
      <ViewTable
        title="Viewing schedule"
        rows={viewings.rows}
        rowKey={(row) => row.id}
        columns={[
          ['Date', (row) => `${row.date} ${row.time}`],
          ['Buyer', (row) => row.buyerName],
          ['Listing', (row) => row.address],
          ['Agent', (row) => row.agentName],
          ['Status', (row) => formatStatus(row.status)],
          ['Virtual', (row) => row.virtual ? 'yes' : 'no']
        ]}
      />
      <div className="two-column">
        <ViewTable
          title="Inquiry queue"
          rows={inquiries.rows}
          rowKey={(row) => row.id}
          columns={[
            ['Buyer', (row) => row.buyerName],
            ['Listing', (row) => row.address],
            ['Budget', (row) => money(row.budget)],
            ['Status', (row) => formatStatus(row.status)]
          ]}
        />
        <ViewTable
          title="Offer book"
          rows={offers.rows}
          rowKey={(row) => row.id}
          columns={[
            ['Buyer', (row) => row.buyerName],
            ['Listing', (row) => row.address],
            ['Offer', (row) => money(row.amount)],
            ['Status', (row) => formatStatus(row.status)]
          ]}
        />
      </div>
    </section>
  );
}

function WriteActions({
  selectedListingId,
  onSelectListing
}: {
  readonly selectedListingId: string;
  readonly onSelectListing: (id: string) => void;
}) {
  const listingOptions = useView(allListingsQuery);
  const listingState = useRow(schema.listings, selectedListingId);
  const mutation = useTarstateMutation();
  const [nextInquiryNumber, setNextInquiryNumber] = useState(1);
  const [lastAction, setLastAction] = useState('No writes yet.');
  const selectedListing = listingState.row;
  const disabled = mutation.pending || selectedListing === undefined;

  const commit = async (label: string, input: Parameters<typeof mutation.commit>[0]) => {
    const result = await mutation.commit(input);
    setLastAction(`${label} (${formatCommit(result)}).`);
    return result;
  };
  const updateStatus = () => selectedListing === undefined
    ? undefined
    : commit(`Updated listing status to ${formatStatus(nextStatus(selectedListing.status))}`, updateByKey(schema.listings, selectedListing.id, { status: nextStatus(selectedListing.status) }));
  const reducePrice = () => selectedListing === undefined
    ? undefined
    : commit(`Reduced price to ${money(Math.max(100000, selectedListing.price - 10000))}`, updateByKey(schema.listings, selectedListing.id, { price: Math.max(100000, selectedListing.price - 10000) }));
  const addInquiry = async () => {
    if (selectedListing === undefined) return;
    const id = `inquiry-demo-${nextInquiryNumber}`;
    const result = await commit(`Inserted ${id}`, insert(schema.inquiries, {
      id,
      listingId: selectedListing.id,
      agentId: selectedListing.agentId,
      buyerName: `Demo Buyer ${nextInquiryNumber}`,
      budget: selectedListing.price + 25000,
      status: 'new' satisfies InquiryStatus,
      createdAt: demoDate
    }));
    if (result.reflected) setNextInquiryNumber((value) => value + 1);
  };

  return (
    <section>
      <h2>Write actions</h2>
      <p className="note">useTarstateMutation commits writes; subscribed views above update after each reflected commit.</p>
      <fieldset>
        <legend>Target listing</legend>
        <Labeled label="Listing">
          <select value={selectedListingId} onChange={(event) => onSelectListing(event.target.value)}>
            {listingOptions.rows.map((row) => <option key={row.id} value={row.id}>{row.address}</option>)}
          </select>
        </Labeled>
        <div className="actions">
          <button disabled={disabled} type="button" onClick={updateStatus}>Cycle status</button>
          <button disabled={disabled} type="button" onClick={reducePrice}>Lower price</button>
          <button disabled={disabled} type="button" onClick={addInquiry}>Add inquiry</button>
          <button type="button" onClick={mutation.reset}>Reset mutation state</button>
        </div>
      </fieldset>
      <Summary items={[
        ['pending', mutation.pending ? 'yes' : 'no'],
        ['last result', mutation.result === undefined ? 'none' : formatCommit(mutation.result)],
        ['last action', lastAction]
      ]} />
    </section>
  );
}

function ViewTable<Row>({
  title,
  rows,
  rowKey,
  columns
}: {
  readonly title: string;
  readonly rows: readonly Row[];
  readonly rowKey: (row: Row) => string;
  readonly columns: readonly Column<Row>[];
}) {
  return (
    <div>
      <h3>{title}</h3>
      <Table rows={rows} rowKey={rowKey} columns={columns} />
    </div>
  );
}

function Table<Row>({
  rows,
  rowKey,
  columns,
  empty = 'No rows.',
  rowClass
}: {
  readonly rows: readonly Row[];
  readonly rowKey: (row: Row) => string;
  readonly columns: readonly Column<Row>[];
  readonly empty?: string;
  readonly rowClass?: (row: Row) => string | undefined;
}) {
  return (
    <table>
      <thead>
        <tr>{columns.map(([heading]) => <th key={heading}>{heading}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr className={rowClass?.(row)} key={rowKey(row)}>
            {columns.map(([heading, render]) => <td key={heading}>{render(row)}</td>)}
          </tr>
        ))}
        {rows.length === 0 ? <tr><td colSpan={columns.length}>{empty}</td></tr> : null}
      </tbody>
    </table>
  );
}

function Summary({ items }: { readonly items: readonly (readonly [label: string, value: ReactNode])[] }) {
  return (
    <dl className="summary">
      {items.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
    </dl>
  );
}

function Labeled({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return <label>{label}{children}</label>;
}

function NumberFilter({
  label,
  value,
  onChange,
  min,
  max,
  step
}: {
  readonly label: string;
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
}) {
  return (
    <Labeled label={label}>
      <input min={min} max={max} step={step} type="number" value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </Labeled>
  );
}

function nextStatus(status: ListingStatus): ListingStatus {
  const index = listingStatuses.indexOf(status);
  return listingStatuses[(index + 1) % listingStatuses.length] ?? 'active';
}

function isOneOf<const Values extends readonly string[]>(values: Values, value: string): value is Values[number] {
  return values.some((item) => item === value);
}

function isListingStatusFilter(value: string): value is ListingFilters['status'] {
  return value === 'all' || isOneOf(listingStatuses, value);
}

function isNeighborhoodFilter(value: string): value is ListingFilters['neighborhoodId'] {
  return value === 'all' || neighborhoods.some((item) => item.id === value);
}

function parseListingStatusFilter(value: string): ListingFilters['status'] | undefined {
  return isListingStatusFilter(value) ? value : undefined;
}

function parseNeighborhoodFilter(value: string): ListingFilters['neighborhoodId'] | undefined {
  return isNeighborhoodFilter(value) ? value : undefined;
}

function money(value: number | undefined): string {
  return value === undefined ? '-' : currency.format(value);
}

function countText(value: number | undefined): string {
  return value === undefined ? '-' : String(value);
}

function formatStatus(value: string): string {
  return value.replaceAll('_', ' ');
}

function formatCommit(result: {
  readonly status: string;
  readonly reflected: boolean;
  readonly effects: { readonly applied: number };
}): string {
  return `${result.status}, reflected ${result.reflected ? 'yes' : 'no'}, applied ${result.effects.applied}`;
}
