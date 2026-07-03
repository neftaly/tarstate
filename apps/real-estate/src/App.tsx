import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type Dispatch,
  type FormEvent,
  type SetStateAction
} from 'react';
import {
  TarstateProvider,
  useCommit,
  useQuery,
  useRow,
  useTarstateSnapshot,
  useTarstateStore,
  useView
} from '@tarstate/react';
import { validateConstraints, type RelationRef, type TarstateDiagnostic } from '@tarstate/core';
import { row, type Db, type DbTransactionContext } from '@tarstate/core/db';
import {
  explainMaterialization,
  index as materializedIndex,
  readMaterializedQuery
} from '@tarstate/core/materialization';
import { queryKey, type Query } from '@tarstate/core/query';
import type { StoreCommitResult } from '@tarstate/core/store';
import { diffQuery } from '@tarstate/core/watch';
import { insert, updateByKey } from '@tarstate/core/write';
import {
  financingTypes,
  inquiryStatuses,
  listingStatuses,
  neighborhoods,
  offerStatuses,
  propertyTypes,
  realEstateConstraints,
  schema,
  type FinancingType,
  type InquiryStatus,
  type ListingStatus,
  type OfferStatus,
  type PropertyType
} from './domain';
import {
  allListingsQuery,
  defaultFilters,
  inquiryQueueQuery,
  listingLookupQuery,
  listingWalkthroughQuery,
  listingsByNeighborhoodIndex,
  listingsByPriceIndex,
  neighborhoodMarketSummaryQuery,
  offerBookQuery,
  openHouseJoinQuery,
  openHouseScheduleQuery,
  pipelineByListingQuery,
  topPricedListingsQuery,
  type ListingFilters,
  type ListingIndexRow,
  type MarketSummaryRow,
  type ListingResult
} from './queries';
import { createRealEstateStore } from './store';

type CommitReport = {
  readonly label: string;
  readonly status: StoreCommitResult['status'];
  readonly reflected: boolean;
  readonly applied: number;
  readonly diagnostics: readonly TarstateDiagnostic[];
};

type AppShellProps = {
  readonly includeInvalidRows: boolean;
  readonly setIncludeInvalidRows: (value: boolean) => void;
  readonly lastCommit: CommitReport | undefined;
  readonly setLastCommit: (report: CommitReport | undefined) => void;
};

type SelectOption<Value extends string> = {
  readonly value: Value;
  readonly label: string;
};

const fixtureDate = '2026-07-03';
const jsonIndent = 2;
const queryKeyPrefix = 'query:';
const currencyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0
});
const wholeNumberFormatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const decimalFormatter = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1
});

const statusOptions: readonly SelectOption<ListingStatus | 'all'>[] = [
  { value: 'all', label: 'All statuses' },
  ...listingStatuses.map((status) => ({ value: status, label: formatStatus(status) }))
];

const propertyTypeOptions: readonly SelectOption<PropertyType | 'all'>[] = [
  { value: 'all', label: 'All types' },
  ...propertyTypes.map((type) => ({ value: type, label: formatStatus(type) }))
];

const walkthroughLinks = [
  { id: 'source', label: 'Source' },
  { id: 'query', label: 'Query' },
  { id: 'hooks', label: 'Hooks' },
  { id: 'joins', label: 'Joins' },
  { id: 'aggregates', label: 'Aggregates' },
  { id: 'topn', label: 'Top-N' },
  { id: 'indexes', label: 'Indexes' },
  { id: 'transactions', label: 'Writes' },
  { id: 'diagnostics', label: 'Diagnostics' },
  { id: 'live', label: 'Live' }
] as const;

const relationOptions = [
  { name: 'neighborhoods', label: 'Neighborhoods', relation: schema.neighborhoods },
  { name: 'agents', label: 'Agents', relation: schema.agents },
  { name: 'listings', label: 'Listings', relation: schema.listings },
  { name: 'openHouses', label: 'Open houses', relation: schema.openHouses },
  { name: 'inquiries', label: 'Inquiries', relation: schema.inquiries },
  { name: 'offers', label: 'Offers', relation: schema.offers }
] as const satisfies readonly {
  readonly name: string;
  readonly label: string;
  readonly relation: RelationRef;
}[];

const marketMaterializationExplanation = explainMaterialization(neighborhoodMarketSummaryQuery);

export function App() {
  const [includeInvalidRows, setIncludeInvalidRowsState] = useState(false);
  const [lastCommit, setLastCommit] = useState<CommitReport | undefined>(undefined);
  const store = useMemo(() => createRealEstateStore(includeInvalidRows), [includeInvalidRows]);

  const setIncludeInvalidRows = useCallback((value: boolean) => {
    setLastCommit(undefined);
    setIncludeInvalidRowsState(value);
  }, []);

  return (
    <TarstateProvider store={store}>
      <AppShell
        includeInvalidRows={includeInvalidRows}
        setIncludeInvalidRows={setIncludeInvalidRows}
        lastCommit={lastCommit}
        setLastCommit={setLastCommit}
      />
    </TarstateProvider>
  );
}

function AppShell({ includeInvalidRows, setIncludeInvalidRows, lastCommit, setLastCommit }: AppShellProps) {
  const [filters, setFilters] = useState<ListingFilters>(defaultFilters);
  const [selectedListingId, setSelectedListingId] = useState('listing-pine-402');
  const snapshot = useTarstateSnapshot();
  const listings = snapshot.db.data.listings?.length ?? 0;
  const offers = snapshot.db.data.offers?.length ?? 0;
  const inquiries = snapshot.db.data.inquiries?.length ?? 0;

  return (
    <div className="app">
      <header className="topbar">
        <div className="header-title">
          <p className="eyebrow">Tarstate walkthrough</p>
          <h1>Real Estate Operations Dataset</h1>
        </div>
        <nav className="header-nav" aria-label="Walkthrough sections">
          {walkthroughLinks.map((link) => (
            <a key={link.id} href={`#${link.id}`}>{link.label}</a>
          ))}
        </nav>
        <div className="topbar-metrics" aria-label="Store metrics">
          <Metric label="revision" value={String(snapshot.revision)} />
          <Metric label="listings" value={String(listings)} />
          <Metric label="offers" value={String(offers)} />
          <Metric label="inquiries" value={String(inquiries)} />
        </div>
      </header>

      <div className="layout">
        <main className="content">
          <SourceDataSection />
          <ListingsSection
            filters={filters}
            setFilters={setFilters}
            selectedListingId={selectedListingId}
            setSelectedListingId={setSelectedListingId}
          />
          <HooksSection selectedListingId={selectedListingId} />
          <JoinsSection />
          <MarketSection />
          <TopNSection />
          <MaterializedIndexSection />
          <TransactionsSection
            selectedListingId={selectedListingId}
            setSelectedListingId={setSelectedListingId}
            lastCommit={lastCommit}
            setLastCommit={setLastCommit}
          />
          <DiagnosticsSection
            includeInvalidRows={includeInvalidRows}
            setIncludeInvalidRows={setIncludeInvalidRows}
            lastCommit={lastCommit}
          />
          <LiveChangesSection
            selectedListingId={selectedListingId}
            setSelectedListingId={setSelectedListingId}
            setLastCommit={setLastCommit}
          />
        </main>
      </div>
    </div>
  );
}

function SourceDataSection() {
  const snapshot = useTarstateSnapshot();
  const [selectedRelationName, setSelectedRelationName] = useState('listings');
  const selected = relationOptionFor(selectedRelationName);
  const rows = snapshot.db.data[selected.name] ?? [];
  const relationSummary = useMemo(() => describeRelation(selected.relation), [selected.relation]);
  const relationCounts = useMemo(() => relationOptions.map((item) => ({
    relation: item.label,
    rows: snapshot.db.data[item.name]?.length ?? 0,
    key: item.relation.key
  })), [snapshot.db]);

  return (
    <section className="walkthrough-section" id="source">
      <SectionHeader
        step="01"
        title="Source Data And Schema"
        detail="The app starts with typed relations for listings, agents, inquiries, open houses, offers, and neighborhood market data"
      />
      <div className="tool-grid">
        <div className="tool-panel">
          <div className="panel-title">Relation snapshot</div>
          <label>
            Relation
            <select
              name="sourceRelation"
              value={selectedRelationName}
              onChange={(event) => setSelectedRelationName(event.target.value)}
            >
              {relationOptions.map((item) => (
                <option key={item.name} value={item.name}>{item.label}</option>
              ))}
            </select>
          </label>
          <div className="table-wrap compact-table">
            <table>
              <thead>
                <tr>
                  <th>Relation</th>
                  <th>Rows</th>
                  <th>Key</th>
                </tr>
              </thead>
              <tbody>
                {relationCounts.map((item) => (
                  <tr key={item.relation}>
                    <td>{item.relation}</td>
                    <td>{item.rows}</td>
                    <td className="mono">{Array.isArray(item.key) ? item.key.join(', ') : item.key}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="json-grid">
          <div className="tool-panel">
            <div className="panel-title">Schema JSON</div>
            <JsonBlock value={relationSummary} />
          </div>
          <div className="tool-panel">
            <div className="panel-title">Sample rows</div>
            <JsonBlock value={rows.slice(0, 3)} />
          </div>
        </div>
      </div>
    </section>
  );
}

function ListingsSection({
  filters,
  setFilters,
  selectedListingId,
  setSelectedListingId
}: {
  readonly filters: ListingFilters;
  readonly setFilters: Dispatch<SetStateAction<ListingFilters>>;
  readonly selectedListingId: string;
  readonly setSelectedListingId: (id: string) => void;
}) {
  const query = useMemo(() => listingWalkthroughQuery(filters), [filters]);
  const queryResetKey = useQueryResetKey(query);
  const view = useView(query, { resetKey: queryResetKey });
  const totals = useQuery(query, {
    resetKey: queryResetKey,
    select: selectListingTotals
  });
  const neighborhoodOptions = useMemo<readonly SelectOption<string>[]>(() => [
    { value: 'all', label: 'All neighborhoods' },
    ...neighborhoods.map((item) => ({ value: item.id, label: item.name }))
  ], []);

  const updateFilter = <Key extends keyof ListingFilters>(key: Key, value: ListingFilters[Key]) => {
    setFilters((current) => ({ ...current, [key]: value }));
  };

  return (
    <section className="walkthrough-section" id="query">
      <SectionHeader
        step="02"
        title="Query As Data"
        detail="Build a filter, sort, and select query from controls and inspect the query object as data"
      />
      <div className="tool-grid">
        <div className="tool-panel">
          <div className="panel-title">Controls</div>
          <label>
            Status
            <select
              name="listingStatusFilter"
              value={filters.status}
              onChange={(event) => updateFilter('status', event.target.value as ListingFilters['status'])}
            >
              {statusOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label>
            Neighborhood
            <select
              name="listingNeighborhoodFilter"
              value={filters.neighborhoodId}
              onChange={(event) => updateFilter('neighborhoodId', event.target.value)}
            >
              {neighborhoodOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label>
            Property type
            <select
              name="listingPropertyTypeFilter"
              value={filters.propertyType}
              onChange={(event) => updateFilter('propertyType', event.target.value as ListingFilters['propertyType'])}
            >
              {propertyTypeOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label>
            Max price
            <input
              name="listingMaxPrice"
              type="range"
              min="550000"
              max="1400000"
              step="25000"
              value={filters.maxPrice}
              onChange={(event) => updateFilter('maxPrice', Number(event.target.value))}
            />
            <output>{formatCurrency(filters.maxPrice)}</output>
          </label>
          <label>
            Min bedrooms
            <input
              name="listingMinBedrooms"
              type="number"
              min="0"
              max="6"
              value={filters.minBedrooms}
              onChange={(event) => updateFilter('minBedrooms', Number(event.target.value))}
            />
          </label>
          <label>
            Sort
            <select
              name="listingSort"
              value={filters.sort}
              onChange={(event) => updateFilter('sort', event.target.value as ListingFilters['sort'])}
            >
              <option value="price_asc">Price ascending</option>
              <option value="price_desc">Price descending</option>
              <option value="newest">Newest listed</option>
            </select>
          </label>
        </div>

        <div className="tool-panel query-panel">
          <div className="panel-title">Current Query</div>
          <dl className="fact-list">
            <div>
              <dt>Query key</dt>
              <dd><QueryKeyBlock value={view.queryKey} /></dd>
            </div>
            <div>
              <dt>Rows</dt>
              <dd>{totals.data.count}</dd>
            </div>
            <div>
              <dt>Average price</dt>
              <dd>{formatCurrency(totals.data.averagePrice)}</dd>
            </div>
            <div>
              <dt>Diagnostics</dt>
              <dd>{view.diagnostics.length}</dd>
            </div>
          </dl>
          <JsonBlock value={query.data} />
        </div>
      </div>

      <div className="listing-grid" aria-label="Filtered listings">
        {view.rows.map((item) => (
          <ListingCard
            key={item.id}
            listing={item}
            selected={selectedListingId === item.id}
            onSelect={() => setSelectedListingId(item.id)}
          />
        ))}
        {view.rows.length === 0 ? <EmptyState label="No listings match the current filters." /> : null}
      </div>
    </section>
  );
}

function ListingCard({
  listing,
  selected,
  onSelect
}: {
  readonly listing: ListingResult;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <button className={selected ? 'listing-card selected' : 'listing-card'} type="button" onClick={onSelect}>
      <span className="listing-card-top">
        <strong>{listing.address}</strong>
        <StatusBadge status={listing.status} />
      </span>
      <span className="muted">{listing.neighborhoodName} / {listing.agentName}</span>
      <span className="listing-card-metrics">
        <span>{formatCurrency(listing.price)}</span>
        <span>{listing.bedrooms} bd</span>
        <span>{listing.bathrooms} ba</span>
        <span>{formatNumber(listing.sqft)} sqft</span>
      </span>
    </button>
  );
}

function HooksSection({ selectedListingId }: { readonly selectedListingId: string }) {
  const listingRow = useRow(schema.listings, selectedListingId);
  const lookupQuery = useMemo(() => listingLookupQuery(selectedListingId), [selectedListingId]);
  const lookupResetKey = useQueryResetKey(lookupQuery);
  const lookupView = useView(lookupQuery, { resetKey: lookupResetKey });
  const openHouses = useView(openHouseScheduleQuery);
  const selectedOpenHouses = useMemo(
    () => openHouses.rows.filter((item) => item.listingId === selectedListingId),
    [openHouses.rows, selectedListingId]
  );

  return (
    <section className="walkthrough-section" id="hooks">
      <SectionHeader
        step="03"
        title="Hooks And Store Reads"
        detail="useRow, useView, and lookup query output for the selected listing"
      />
      <div className="split">
        <div className="tool-panel">
          <div className="panel-title">Selected Row</div>
          {listingRow.row === undefined ? (
            <EmptyState label="Select a listing to inspect the row hook." />
          ) : (
            <dl className="fact-list">
              <div>
                <dt>Address</dt>
                <dd>{listingRow.row.address}</dd>
              </div>
              <div>
                <dt>List price</dt>
                <dd>{formatCurrency(listingRow.row.price)}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd><StatusBadge status={listingRow.row.status} /></dd>
              </div>
              <div>
                <dt>useRow revision</dt>
                <dd>{listingRow.revision}</dd>
              </div>
            </dl>
          )}
        </div>
        <div className="tool-panel">
          <div className="panel-title">Lookup View</div>
          <dl className="fact-list">
            <div>
              <dt>Lookup rows</dt>
              <dd>{lookupView.rows.length}</dd>
            </div>
            <div>
              <dt>Lookup key</dt>
              <dd><QueryKeyBlock value={lookupView.queryKey} /></dd>
            </div>
            <div>
              <dt>Open houses</dt>
              <dd>{selectedOpenHouses.length}</dd>
            </div>
          </dl>
          <div className="compact-list">
            {selectedOpenHouses.map((item) => (
              <div className="compact-row" key={item.id}>
                <span>{formatDate(item.date)} {item.startsAt}</span>
                <span>{item.hostAgent}</span>
                <span>{item.expectedVisitors} visitors</span>
              </div>
            ))}
            {selectedOpenHouses.length === 0 ? <EmptyState label="No open houses for this listing." /> : null}
          </div>
        </div>
      </div>
    </section>
  );
}

function JoinsSection() {
  const [brokerOnly, setBrokerOnly] = useState(false);
  const joinQuery = useMemo(() => openHouseJoinQuery(brokerOnly), [brokerOnly]);
  const joinResetKey = useQueryResetKey(joinQuery);
  const schedule = useView(joinQuery, { resetKey: joinResetKey });

  return (
    <section className="walkthrough-section" id="joins">
      <SectionHeader
        step="04"
        title="Joins"
        detail="Open houses joined to listings, host agents, and neighborhoods"
      />
      <div className="tool-grid">
        <div className="tool-panel">
          <div className="panel-title">Join controls</div>
          <label className="switch-row">
            <input
              name="brokerOnlyOpenHouses"
              type="checkbox"
              checked={brokerOnly}
              onChange={(event) => setBrokerOnly(event.target.checked)}
            />
            Broker-only events
          </label>
          <dl className="fact-list">
            <div>
              <dt>Rows</dt>
              <dd>{schedule.rows.length}</dd>
            </div>
            <div>
              <dt>Query key</dt>
              <dd><QueryKeyBlock value={schedule.queryKey} /></dd>
            </div>
            <div>
              <dt>Diagnostics</dt>
              <dd>{schedule.diagnostics.length}</dd>
            </div>
          </dl>
          <JsonBlock value={joinQuery.data} />
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Listing</th>
                <th>Neighborhood</th>
                <th>Host</th>
                <th>Visitors</th>
              </tr>
            </thead>
            <tbody>
              {schedule.rows.map((item) => (
                <tr key={item.id}>
                  <td>{formatDate(item.date)} <span className="table-sub">{item.startsAt}</span></td>
                  <td>{item.address}</td>
                  <td>{item.neighborhoodName}</td>
                  <td>{item.hostAgent}</td>
                  <td>{item.expectedVisitors}{item.brokerOnly ? <span className="table-sub">broker-only</span> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function MarketSection() {
  const market = useView(neighborhoodMarketSummaryQuery);
  const pipeline = useView(pipelineByListingQuery);
  const rollup = useQuery(neighborhoodMarketSummaryQuery, {
    select: selectMarketRollup
  });

  return (
    <section className="walkthrough-section" id="aggregates">
      <SectionHeader
        step="05"
        title="Aggregations"
        detail="Neighborhood market stats with agg rollups and listing pipeline rows"
      />
      <div className="metric-strip">
        <Metric label="active listings" value={String(rollup.data.active)} />
        <Metric label="total listings" value={String(rollup.data.listings)} />
        <Metric label="avg DOM" value={formatDecimal(rollup.data.averageDays)} />
        <Metric label="pipeline rows" value={String(pipeline.rows.length)} />
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Neighborhood</th>
              <th>Inventory</th>
              <th>Active</th>
              <th>Avg list</th>
              <th>Range</th>
              <th>Median</th>
              <th>DOM</th>
            </tr>
          </thead>
          <tbody>
            {market.rows.map((item) => (
              <tr key={item.neighborhoodId}>
                <td>
                  <strong>{item.neighborhoodName}</strong>
                  <span className="table-sub">{item.borough} / walk {item.walkScore}</span>
                </td>
                <td>{item.inventory}</td>
                <td>{safeNumber(item.activeCount)}</td>
                <td>{formatCurrency(item.avgPrice)}</td>
                <td>{formatCurrency(item.minPrice)} - {formatCurrency(item.maxPrice)}</td>
                <td>{formatCurrency(item.medianPrice)}</td>
                <td>{item.daysOnMarket}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="pipeline-list">
        {pipeline.rows.slice(0, 4).map((item) => (
          <div className="pipeline-row" key={item.listingId}>
            <strong>{item.address}</strong>
            <span>{item.agentName}</span>
            <span>{safeNumber(item.inquiryCount)} inquiries</span>
            <span>{safeNumber(item.submittedOffers)} offers</span>
            <span>{formatCurrency(item.topOffer)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function TopNSection() {
  const [countValue, setCountValue] = useState(4);
  const [status, setStatus] = useState<ListingStatus | 'all'>('active');
  const query = useMemo(() => topPricedListingsQuery(countValue, status), [countValue, status]);
  const queryResetKey = useQueryResetKey(query);
  const topRows = useView(query, { resetKey: queryResetKey });

  return (
    <section className="walkthrough-section" id="topn">
      <SectionHeader
        step="06"
        title="Sorted Top-N"
        detail="A bounded listing leaderboard built with sortLimit"
      />
      <div className="tool-grid">
        <div className="tool-panel">
          <div className="panel-title">Top-N controls</div>
          <label>
            Count
            <input
              name="topListingCount"
              type="number"
              min="1"
              max="8"
              value={countValue}
              onChange={(event) => setCountValue(clamp(Number(event.target.value), 1, 8))}
            />
          </label>
          <label>
            Status
            <select
              name="topListingStatus"
              value={status}
              onChange={(event) => setStatus(event.target.value as ListingStatus | 'all')}
            >
              {statusOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <dl className="fact-list">
            <div>
              <dt>Rows</dt>
              <dd>{topRows.rows.length}</dd>
            </div>
            <div>
              <dt>Query key</dt>
              <dd><QueryKeyBlock value={topRows.queryKey} /></dd>
            </div>
          </dl>
          <JsonBlock value={query.data} />
        </div>
        <div className="compact-list top-list">
          {topRows.rows.map((item, indexValue) => (
            <div className="rank-row" key={item.id}>
              <strong>{indexValue + 1}</strong>
              <span>{item.address}</span>
              <span>{item.neighborhoodName}</span>
              <span>{item.agentName}</span>
              <span>{formatCurrency(item.price)}</span>
              <StatusBadge status={item.status} />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function MaterializedIndexSection() {
  const snapshot = useTarstateSnapshot();
  const [neighborhoodId, setNeighborhoodId] = useState('nh-capitol-hill');
  const [priceFloor, setPriceFloor] = useState(650000);
  const [priceCeiling, setPriceCeiling] = useState(1000000);
  const byNeighborhood = useMemo(
    () => materializedIndex<ListingIndexRow>(snapshot.db, listingsByNeighborhoodIndex),
    [snapshot.db]
  );
  const byPrice = useMemo(
    () => materializedIndex<ListingIndexRow>(snapshot.db, listingsByPriceIndex),
    [snapshot.db]
  );
  const neighborhoodRows = useMemo(
    () => byNeighborhood?.op === 'hash' ? byNeighborhood.lookup(neighborhoodId) : [],
    [byNeighborhood, neighborhoodId]
  );
  const priceRows = useMemo(() => byPrice?.op === 'btree'
    ? byPrice.range({
        lower: { value: priceFloor, inclusive: true },
        upper: { value: priceCeiling, inclusive: true }
      })
    : [], [byPrice, priceCeiling, priceFloor]);
  const materializedMarket = useMemo(
    () => readMaterializedQuery(snapshot.db, neighborhoodMarketSummaryQuery),
    [snapshot.db]
  );

  return (
    <section className="walkthrough-section" id="indexes">
      <SectionHeader
        step="07"
        title="Materialized Index Reads"
        detail="Hash and btree snapshots read from the current store DB"
      />
      <div className="tool-grid three">
        <div className="tool-panel">
          <div className="panel-title">Hash lookup</div>
          <label>
            Neighborhood
            <select
              name="indexNeighborhood"
              value={neighborhoodId}
              onChange={(event) => setNeighborhoodId(event.target.value)}
            >
              {neighborhoods.map((item) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
          </label>
          <IndexRows rows={neighborhoodRows} emptyLabel="No rows in this hash bucket." />
        </div>
        <div className="tool-panel">
          <div className="panel-title">Btree range</div>
          <label>
            Floor
            <input
              name="indexPriceFloor"
              type="number"
              step="25000"
              value={priceFloor}
              onChange={(event) => setPriceFloor(Number(event.target.value))}
            />
          </label>
          <label>
            Ceiling
            <input
              name="indexPriceCeiling"
              type="number"
              step="25000"
              value={priceCeiling}
              onChange={(event) => setPriceCeiling(Number(event.target.value))}
            />
          </label>
          <IndexRows rows={priceRows} emptyLabel="No rows in this price range." />
        </div>
        <div className="tool-panel">
          <div className="panel-title">Materialization</div>
          <dl className="fact-list">
            <div>
              <dt>Market rows</dt>
              <dd>{materializedMarket.rows.length}</dd>
            </div>
            <div>
              <dt>Read mode</dt>
              <dd>{materializedMarket.materialized ? 'materialized' : 'evaluated'}</dd>
            </div>
            <div>
              <dt>Maintenance</dt>
              <dd>{marketMaterializationExplanation.update}</dd>
            </div>
            <div>
              <dt>Hash buckets</dt>
              <dd>{byNeighborhood?.op === 'hash' ? byNeighborhood.buckets.length : 0}</dd>
            </div>
            <div>
              <dt>Btree buckets</dt>
              <dd>{byPrice?.op === 'btree' ? byPrice.buckets.length : 0}</dd>
            </div>
          </dl>
        </div>
      </div>
    </section>
  );
}

function IndexRows({ rows, emptyLabel }: { readonly rows: readonly ListingIndexRow[]; readonly emptyLabel: string }) {
  if (rows.length === 0) return <EmptyState label={emptyLabel} />;

  return (
    <div className="compact-list">
      {rows.map((item) => (
        <div className="compact-row" key={item.id}>
          <span>{item.address}</span>
          <span>{formatCurrency(item.price)}</span>
          <span>{item.bedrooms} bd</span>
        </div>
      ))}
    </div>
  );
}

function TransactionsSection({
  selectedListingId,
  setSelectedListingId,
  lastCommit,
  setLastCommit
}: {
  readonly selectedListingId: string;
  readonly setSelectedListingId: (id: string) => void;
  readonly lastCommit: CommitReport | undefined;
  readonly setLastCommit: (report: CommitReport | undefined) => void;
}) {
  const commit = useCommit();
  const listingRow = useRow(schema.listings, selectedListingId);
  const allListings = useView(allListingsQuery);
  const offers = useView(offerBookQuery);
  const inquiries = useView(inquiryQueueQuery);
  const [inquiryDraft, setInquiryDraft] = useState({
    buyerName: 'Taylor Kim',
    budget: 780000,
    financing: 'conventional' as FinancingType,
    status: 'new' as InquiryStatus,
    notes: ''
  });
  const [offerDraft, setOfferDraft] = useState({
    buyerName: 'Taylor Kim',
    amount: 700000,
    financing: 'conventional' as FinancingType,
    contingencies: 'Inspection',
    status: 'submitted' as OfferStatus
  });

  const selectedListing = listingRow.row;

  const handleInquirySubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (selectedListing === undefined) return;

    const result = await commit(insert(schema.inquiries, {
      id: makeId('inq'),
      listingId: selectedListing.id,
      agentId: selectedListing.agentId,
      buyerName: inquiryDraft.buyerName,
      budget: inquiryDraft.budget,
      financing: inquiryDraft.financing,
      status: inquiryDraft.status,
      createdAt: fixtureDate,
      notes: inquiryDraft.notes.trim() === '' ? null : inquiryDraft.notes
    }));

    setLastCommit(toCommitReport('Add inquiry', result));
  };

  const handleOfferSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (selectedListing === undefined) return;

    const listingId = selectedListing.id;
    const result = await commit([
      insert(schema.offers, {
        id: makeId('offer'),
        listingId,
        buyerName: offerDraft.buyerName,
        amount: offerDraft.amount,
        financing: offerDraft.financing,
        contingencies: offerDraft.contingencies.trim() === '' ? null : offerDraft.contingencies,
        status: offerDraft.status,
        submittedAt: fixtureDate
      }),
      (tx: DbTransactionContext) => {
        const current = row(tx, schema.listings, listingId);
        if (current === undefined || offerDraft.amount < current.price * 0.98) return [];
        return updateByKey(schema.listings, listingId, { status: 'under_contract' });
      }
    ]);

    setLastCommit(toCommitReport('Add offer transaction', result));
  };

  const commitInvalidOffer = async () => {
    const result = await commit(insert(schema.offers, {
      id: makeId('offer-invalid'),
      listingId: 'listing-missing',
      buyerName: 'Invalid Import',
      amount: 0,
      financing: 'cash',
      contingencies: null,
      status: 'submitted',
      submittedAt: fixtureDate
    }));
    setLastCommit(toCommitReport('Rejected invalid offer', result));
  };

  const updateOfferStatus = async (offerId: string, status: OfferStatus) => {
    const result = await commit(updateByKey(schema.offers, offerId, { status }));
    setLastCommit(toCommitReport('Update offer status', result));
  };

  const updateInquiryStatus = async (inquiryId: string, status: InquiryStatus) => {
    const result = await commit(updateByKey(schema.inquiries, inquiryId, { status }));
    setLastCommit(toCommitReport('Update inquiry status', result));
  };

  return (
    <section className="walkthrough-section" id="transactions">
      <SectionHeader
        step="08"
        title="Transactions And Commit Envelope"
        detail="Inquiry and offer writes committed through the Tarstate store"
      />
      <div className="tool-grid">
        <form className="tool-panel" onSubmit={handleInquirySubmit}>
          <div className="panel-title">Add inquiry</div>
          <ListingSelect value={selectedListingId} rows={allListings.rows} onChange={setSelectedListingId} />
          <label>
            Buyer
            <input
              name="inquiryBuyerName"
              value={inquiryDraft.buyerName}
              onChange={(event) => setInquiryDraft((draft) => ({ ...draft, buyerName: event.target.value }))}
            />
          </label>
          <label>
            Budget
            <input
              name="inquiryBudget"
              type="number"
              step="10000"
              value={inquiryDraft.budget}
              onChange={(event) => setInquiryDraft((draft) => ({ ...draft, budget: Number(event.target.value) }))}
            />
          </label>
          <label>
            Financing
            <select
              name="inquiryFinancing"
              value={inquiryDraft.financing}
              onChange={(event) => setInquiryDraft((draft) => ({ ...draft, financing: event.target.value as FinancingType }))}
            >
              {financingTypes.map((item) => <option key={item} value={item}>{formatStatus(item)}</option>)}
            </select>
          </label>
          <label>
            Status
            <select
              name="inquiryStatus"
              value={inquiryDraft.status}
              onChange={(event) => setInquiryDraft((draft) => ({ ...draft, status: event.target.value as InquiryStatus }))}
            >
              {inquiryStatuses.map((item) => <option key={item} value={item}>{formatStatus(item)}</option>)}
            </select>
          </label>
          <label>
            Notes
            <textarea
              name="inquiryNotes"
              value={inquiryDraft.notes}
              onChange={(event) => setInquiryDraft((draft) => ({ ...draft, notes: event.target.value }))}
            />
          </label>
          <button type="submit">Add inquiry</button>
        </form>

        <form className="tool-panel" onSubmit={handleOfferSubmit}>
          <div className="panel-title">Add offer</div>
          <ListingSelect value={selectedListingId} rows={allListings.rows} onChange={setSelectedListingId} />
          <label>
            Buyer
            <input
              name="offerBuyerName"
              value={offerDraft.buyerName}
              onChange={(event) => setOfferDraft((draft) => ({ ...draft, buyerName: event.target.value }))}
            />
          </label>
          <label>
            Amount
            <input
              name="offerAmount"
              type="number"
              step="10000"
              value={offerDraft.amount}
              onChange={(event) => setOfferDraft((draft) => ({ ...draft, amount: Number(event.target.value) }))}
            />
          </label>
          <label>
            Financing
            <select
              name="offerFinancing"
              value={offerDraft.financing}
              onChange={(event) => setOfferDraft((draft) => ({ ...draft, financing: event.target.value as FinancingType }))}
            >
              {financingTypes.map((item) => <option key={item} value={item}>{formatStatus(item)}</option>)}
            </select>
          </label>
          <label>
            Status
            <select
              name="offerStatus"
              value={offerDraft.status}
              onChange={(event) => setOfferDraft((draft) => ({ ...draft, status: event.target.value as OfferStatus }))}
            >
              {offerStatuses.map((item) => <option key={item} value={item}>{formatStatus(item)}</option>)}
            </select>
          </label>
          <label>
            Contingencies
            <textarea
              name="offerContingencies"
              value={offerDraft.contingencies}
              onChange={(event) => setOfferDraft((draft) => ({ ...draft, contingencies: event.target.value }))}
            />
          </label>
          <div className="button-row">
            <button type="submit">Add offer</button>
            <button className="secondary" type="button" onClick={() => void commitInvalidOffer()}>
              Commit invalid
            </button>
          </div>
        </form>
      </div>

      <div className="tool-panel commit-panel">
        <div className="panel-title">Last commit envelope</div>
        <JsonBlock value={commitEnvelopeValue(lastCommit)} />
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Offer</th>
              <th>Listing</th>
              <th>Amount</th>
              <th>Status</th>
              <th>Financing</th>
            </tr>
          </thead>
          <tbody>
            {offers.rows.map((item) => (
              <tr key={item.id}>
                <td>{item.buyerName}</td>
                <td>{item.address}</td>
                <td>{formatCurrency(item.amount)} <span className="table-sub">list {formatCurrency(item.listPrice)}</span></td>
                <td>
                  <select
                    className="inline-select"
                    name={`offerStatus-${item.id}`}
                    value={item.status}
                    onChange={(event) => void updateOfferStatus(item.id, event.target.value as OfferStatus)}
                  >
                    {offerStatuses.map((status) => (
                      <option key={status} value={status}>{formatStatus(status)}</option>
                    ))}
                  </select>
                </td>
                <td>{formatStatus(item.financing)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="compact-list two-col">
        {inquiries.rows.map((item) => (
          <div className="compact-row" key={item.id}>
            <span>{item.buyerName}</span>
            <span>{item.address}</span>
            <span>{formatCurrency(item.budget)}</span>
            <select
              className="inline-select"
              name={`inquiryStatus-${item.id}`}
              value={item.status}
              onChange={(event) => void updateInquiryStatus(item.id, event.target.value as InquiryStatus)}
            >
              {inquiryStatuses.map((status) => (
                <option key={status} value={status}>{formatStatus(status)}</option>
              ))}
            </select>
          </div>
        ))}
      </div>
    </section>
  );
}

function ListingSelect({
  value,
  rows,
  onChange
}: {
  readonly value: string;
  readonly rows: readonly ListingResult[];
  readonly onChange: (id: string) => void;
}) {
  return (
    <label>
      Listing
      <select name="selectedListingId" value={value} onChange={(event) => onChange(event.target.value)}>
        {rows.map((item) => (
          <option key={item.id} value={item.id}>{item.address}</option>
        ))}
      </select>
    </label>
  );
}

function DiagnosticsSection({
  includeInvalidRows,
  setIncludeInvalidRows,
  lastCommit
}: {
  readonly includeInvalidRows: boolean;
  readonly setIncludeInvalidRows: (value: boolean) => void;
  readonly lastCommit: CommitReport | undefined;
}) {
  const snapshot = useTarstateSnapshot();
  const diagnosticRead = useView(allListingsQuery);
  const [constraintDiagnostics, setConstraintDiagnostics] = useState<readonly TarstateDiagnostic[]>([]);

  useEffect(() => {
    let active = true;
    void validateConstraints(snapshot.db, realEstateConstraints).then((result) => {
      if (active) setConstraintDiagnostics(result.diagnostics);
    });
    return () => {
      active = false;
    };
  }, [snapshot.db, snapshot.revision]);

  const diagnostics = useMemo(() => [
    ...diagnosticRead.diagnostics,
    ...constraintDiagnostics,
    ...(lastCommit?.diagnostics ?? [])
  ], [constraintDiagnostics, diagnosticRead.diagnostics, lastCommit]);

  return (
    <section className="walkthrough-section" id="diagnostics">
      <SectionHeader
        step="09"
        title="Constraints And Diagnostics"
        detail="Read validation, constraint checks, and rejected commit output"
      />
      <div className="tool-grid">
        <div className="tool-panel">
          <div className="panel-title">Invalid data toggle</div>
          <label className="switch-row">
            <input
              name="includeInvalidRows"
              type="checkbox"
              checked={includeInvalidRows}
              onChange={(event: ChangeEvent<HTMLInputElement>) => setIncludeInvalidRows(event.target.checked)}
            />
            Inject malformed seed rows
          </label>
          <dl className="fact-list">
            <div>
              <dt>Read diagnostics</dt>
              <dd>{diagnosticRead.diagnostics.length}</dd>
            </div>
            <div>
              <dt>Constraint diagnostics</dt>
              <dd>{constraintDiagnostics.length}</dd>
            </div>
            <div>
              <dt>Last commit</dt>
              <dd>{lastCommit === undefined ? 'none' : `${lastCommit.label}: ${lastCommit.status}`}</dd>
            </div>
            <div>
              <dt>Applied patches</dt>
              <dd>{lastCommit?.applied ?? 0}</dd>
            </div>
            <div>
              <dt>Reflected</dt>
              <dd>{lastCommit === undefined ? 'n/a' : String(lastCommit.reflected)}</dd>
            </div>
          </dl>
        </div>

        <div className="tool-panel diagnostics-panel">
          <div className="panel-title">Diagnostics stream</div>
          {diagnostics.length === 0 ? (
            <EmptyState label="No diagnostics in the current store revision." />
          ) : (
            <div className="diagnostic-list">
              {diagnostics.map((item, indexValue) => (
                <div className="diagnostic-row" key={`${item.code}-${indexValue}`}>
                  <span className={item.severity === 'error' ? 'severity error' : 'severity'}>{item.severity ?? 'info'}</span>
                  <span className="mono">{item.code}</span>
                  <span>{item.message}</span>
                  <span className="muted">{[item.relation, item.field, item.surface].filter(Boolean).join(' / ')}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function LiveChangesSection({
  selectedListingId,
  setSelectedListingId,
  setLastCommit
}: {
  readonly selectedListingId: string;
  readonly setSelectedListingId: (id: string) => void;
  readonly setLastCommit: (report: CommitReport | undefined) => void;
}) {
  const commit = useCommit();
  const store = useTarstateStore();
  const snapshot = useTarstateSnapshot();
  const listingRow = useRow(schema.listings, selectedListingId);
  const listings = useView(allListingsQuery);
  const inquiryQueue = useView(inquiryQueueQuery);
  const previousDb = useRef<Db | undefined>(undefined);
  const [subscriptionEvents, setSubscriptionEvents] = useState<readonly string[]>([]);
  const [watchDiff, setWatchDiff] = useState<unknown>(undefined);
  const watchOutput = useMemo(() => watchDiff ?? {
    queryKey: inquiryQueue.queryKey,
    changed: false,
    added: [],
    removed: [],
    unchanged: inquiryQueue.rows
  }, [inquiryQueue.queryKey, inquiryQueue.rows, watchDiff]);

  useEffect(() => {
    previousDb.current = undefined;
    setWatchDiff(undefined);

    return store.subscribe(() => {
      const next = store.getSnapshot();
      setSubscriptionEvents((events) => [
        `revision ${next.revision}: ${next.db.data.inquiries?.length ?? 0} inquiries`,
        ...events
      ].slice(0, 6));
    });
  }, [store]);

  useEffect(() => {
    const previous = previousDb.current;
    previousDb.current = snapshot.db;
    if (previous === undefined || previous === snapshot.db) return undefined;

    let active = true;
    void diffQuery(previous, snapshot.db, inquiryQueueQuery).then((event) => {
      if (active) setWatchDiff(event);
    });

    return () => {
      active = false;
    };
  }, [snapshot.db, snapshot.revision]);

  const addWatchedInquiry = async () => {
    const selectedListing = listingRow.row;
    if (selectedListing === undefined) return;

    const result = await commit(insert(schema.inquiries, {
      id: makeId('inq-live'),
      listingId: selectedListing.id,
      agentId: selectedListing.agentId,
      buyerName: 'Live Watch Buyer',
      budget: Math.round(selectedListing.price * 1.04),
      financing: 'conventional',
      status: 'new',
      createdAt: fixtureDate,
      notes: 'Created from live/watch panel'
    }));
    setLastCommit(toCommitReport('Live inquiry insert', result));
  };

  const raiseListingPrice = async () => {
    const selectedListing = listingRow.row;
    if (selectedListing === undefined) return;

    const result = await commit(updateByKey(schema.listings, selectedListing.id, {
      price: selectedListing.price + 25000
    }));
    setLastCommit(toCommitReport('Raise listing price', result));
  };

  return (
    <section className="walkthrough-section" id="live">
      <SectionHeader
        step="10"
        title="Watch And Live Changes"
        detail="Store subscriptions and query diffs update as committed writes change the operational dataset"
      />
      <div className="tool-grid">
        <div className="tool-panel">
          <div className="panel-title">Live controls</div>
          <ListingSelect value={selectedListingId} rows={listings.rows} onChange={setSelectedListingId} />
          <dl className="fact-list">
            <div>
              <dt>Store revision</dt>
              <dd>{snapshot.revision}</dd>
            </div>
            <div>
              <dt>View revision</dt>
              <dd>{inquiryQueue.revision}</dd>
            </div>
            <div>
              <dt>Inquiry rows</dt>
              <dd>{inquiryQueue.rows.length}</dd>
            </div>
            <div>
              <dt>Watched query</dt>
              <dd><QueryKeyBlock value={inquiryQueue.queryKey} /></dd>
            </div>
          </dl>
          <div className="button-row">
            <button type="button" onClick={() => void addWatchedInquiry()}>Add watched inquiry</button>
            <button className="secondary" type="button" onClick={() => void raiseListingPrice()}>
              Raise listing price
            </button>
          </div>
        </div>
        <div className="tool-panel">
          <div className="panel-title">Watch diff output</div>
          <JsonBlock value={watchOutput} />
        </div>
      </div>
      <div className="compact-list">
        {subscriptionEvents.length === 0 ? (
          <EmptyState label="No store subscription events yet. Commit a change above." />
        ) : subscriptionEvents.map((event, indexValue) => (
          <div className="compact-row live-row" key={`${indexValue}-${event}`}>{event}</div>
        ))}
      </div>
    </section>
  );
}

function useQueryResetKey<Row>(query: Query<Row>): string {
  return useMemo(() => queryKey(query), [query]);
}

function selectListingTotals(rows: readonly ListingResult[]) {
  return {
    count: rows.length,
    averagePrice: rows.length === 0
      ? 0
      : rows.reduce((sum, item) => sum + safeNumber(item.price), 0) / rows.length
  };
}

function selectMarketRollup(rows: readonly MarketSummaryRow[]) {
  return {
    active: rows.reduce((sum, item) => sum + safeNumber(item.activeCount), 0),
    listings: rows.reduce((sum, item) => sum + safeNumber(item.listingCount), 0),
    averageDays: rows.length === 0
      ? 0
      : rows.reduce((sum, item) => sum + safeNumber(item.daysOnMarket), 0) / rows.length
  };
}

function SectionHeader({ step, title, detail }: { readonly step: string; readonly title: string; readonly detail: string }) {
  return (
    <div className="section-header">
      <span>{step}</span>
      <div>
        <h2>{title}</h2>
        <p>{detail}</p>
      </div>
    </div>
  );
}

function Metric({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StatusBadge({ status }: { readonly status: string }) {
  return <span className={`status status-${status}`}>{formatStatus(status)}</span>;
}

function EmptyState({ label }: { readonly label: string }) {
  return <div className="empty-state">{label}</div>;
}

function relationOptionFor(name: string): (typeof relationOptions)[number] {
  return relationOptions.find((item) => item.name === name) ?? relationOptions[0];
}

function QueryKeyBlock({ value }: { readonly value: string }) {
  return <pre className="query-key-code">{formatQueryKey(value)}</pre>;
}

function JsonBlock({ value }: { readonly value: unknown }) {
  return <pre className="query-code">{formatDisplayJson(value)}</pre>;
}

function formatDisplayJson(value: unknown): string {
  return JSON.stringify(normalizeDisplayJson(value), null, jsonIndent) ?? 'undefined';
}

function formatQueryKey(value: string): string {
  const parsed = parseQueryKeyData(value);
  if (parsed !== undefined) return `${queryKeyPrefix}\n${formatDisplayJson(parsed)}`;
  if (value.startsWith(queryKeyPrefix)) return `${queryKeyPrefix}\n${formatJsonLike(value.slice(queryKeyPrefix.length))}`;

  const parsedJson = parseStringifiedJson(value);
  return parsedJson === undefined ? value : formatDisplayJson(parsedJson);
}

function normalizeDisplayJson(value: unknown): unknown {
  if (typeof value === 'string') {
    const queryKeyData = parseQueryKeyData(value);
    if (queryKeyData !== undefined) return normalizeDisplayJson(queryKeyData);

    const parsedJson = parseStringifiedJson(value);
    return parsedJson === undefined ? value : normalizeDisplayJson(parsedJson);
  }

  if (Array.isArray(value)) return value.map((item) => normalizeDisplayJson(item));

  if (isPlainDisplayRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalizeDisplayJson(item)])
    );
  }

  return value;
}

function parseQueryKeyData(value: string): unknown {
  if (!value.startsWith(queryKeyPrefix)) return undefined;
  return parseStringifiedJson(value.slice(queryKeyPrefix.length));
}

function parseStringifiedJson(value: string): unknown {
  const trimmed = value.trim();
  if (!isJsonContainerString(trimmed)) return undefined;

  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function isJsonContainerString(value: string): boolean {
  return (value.startsWith('{') && value.endsWith('}')) || (value.startsWith('[') && value.endsWith(']'));
}

function isPlainDisplayRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function formatJsonLike(value: string): string {
  let output = '';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (const char of value) {
    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }

    if (char === '{' || char === '[') {
      depth += 1;
      output += `${char}\n${' '.repeat(depth * jsonIndent)}`;
      continue;
    }

    if (char === '}' || char === ']') {
      depth = Math.max(0, depth - 1);
      output += `\n${' '.repeat(depth * jsonIndent)}${char}`;
      continue;
    }

    if (char === ',') {
      output += `,\n${' '.repeat(depth * jsonIndent)}`;
      continue;
    }

    output += char === ':' ? ': ' : char;
  }

  return output;
}

function toCommitReport(label: string, result: StoreCommitResult): CommitReport {
  return {
    label,
    status: result.status,
    reflected: result.reflected,
    applied: result.effects.applied,
    diagnostics: result.diagnostics
  };
}

function commitEnvelopeValue(report: CommitReport | undefined) {
  if (report === undefined) {
    return {
      status: 'none',
      reflected: false,
      effects: { applied: 0 },
      diagnostics: []
    };
  }

  return {
    label: report.label,
    status: report.status,
    reflected: report.reflected,
    effects: {
      applied: report.applied
    },
    diagnostics: report.diagnostics
  };
}

function describeRelation(relation: RelationRef) {
  const fields = Object.entries(relation.fields ?? {}).map(([name, spec]) => ({
    name,
    type: describeFieldSpec(spec)
  }));

  return {
    name: relation.name,
    key: relation.key,
    fields
  };
}

function describeFieldSpec(spec: unknown): string {
  if (typeof spec !== 'object' || spec === null) return typeof spec;
  const record = spec as Record<string, unknown>;
  if (typeof record.type === 'string') return record.type;
  if (typeof record.kind === 'string') return record.kind;
  if (typeof record.ref === 'string') return `ref ${record.ref}`;
  return Object.keys(record).join(', ') || 'field';
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function clamp(value: number, minValue: number, maxValue: number): number {
  if (!Number.isFinite(value)) return minValue;
  return Math.min(maxValue, Math.max(minValue, value));
}

function safeNumber(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function formatCurrency(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a';
  return currencyFormatter.format(value);
}

function formatNumber(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '0';
  return wholeNumberFormatter.format(value);
}

function formatDecimal(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '0.0';
  return decimalFormatter.format(value);
}

function formatStatus(value: string): string {
  return value.replaceAll('_', ' ');
}

function formatDate(value: string): string {
  const [year, month, day] = value.split('-');
  if (year === undefined || month === undefined || day === undefined) return value;
  return `${month}/${day}/${year}`;
}
