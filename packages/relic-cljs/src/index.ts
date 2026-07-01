export type RelicCljsDb = {
  readonly kind: 'relicCljsDb';
};

export type RelicCljsChange<Row = unknown> = {
  readonly query: unknown;
  readonly added: readonly Row[];
  readonly deleted: readonly Row[];
};

export type RelicCljsTrackResult<Db extends RelicCljsDb = RelicCljsDb, Row = unknown> = {
  readonly db: Db;
  readonly changes: readonly RelicCljsChange<Row>[];
};

export type RelicCljsModule<Db extends RelicCljsDb = RelicCljsDb> = {
  readonly createDb: (seed?: unknown) => Db;
  readonly snapshot: (db: Db) => unknown;
  readonly q: <Row = unknown>(db: Db, query: unknown) => readonly Row[];
  readonly transact: (db: Db, transaction: unknown) => Db;
  readonly trackTransact: <Row = unknown>(db: Db, transaction: unknown) => RelicCljsTrackResult<Db, Row>;
  readonly mat: (db: Db, query: unknown) => Db;
  readonly watch: (db: Db, query: unknown) => Db;
  readonly unwatch: (db: Db, query: unknown) => Db;
};

export type RelicCljsRuntime<Db extends RelicCljsDb = RelicCljsDb> = {
  readonly kind: 'relicCljsRuntime';
  readonly api: RelicCljsModule<Db>;
  readonly db: () => Db;
  readonly snapshot: () => unknown;
  readonly q: <Row = unknown>(query: unknown) => readonly Row[];
  readonly transact: (transaction: unknown) => Db;
  readonly trackTransact: <Row = unknown>(transaction: unknown) => RelicCljsTrackResult<Db, Row>;
  readonly mat: (query: unknown) => Db;
  readonly watch: (query: unknown) => Db;
  readonly unwatch: (query: unknown) => Db;
};

export type RelicCljsImporter<Db extends RelicCljsDb = RelicCljsDb> = (
  specifier: string
) => Promise<RelicCljsModule<Db>>;

export const defaultRelicCljsModuleSpecifier = '../dist/cljs/relic.js';

export async function loadRelicCljsModule<Db extends RelicCljsDb = RelicCljsDb>(
  importModule: RelicCljsImporter<Db>,
  specifier = defaultRelicCljsModuleSpecifier
): Promise<RelicCljsModule<Db>> {
  return importModule(specifier);
}

export function createRelicCljsRuntime<Db extends RelicCljsDb>(
  api: RelicCljsModule<Db>,
  seed?: unknown
): RelicCljsRuntime<Db> {
  let currentDb = api.createDb(seed);

  const setDb = (nextDb: Db): Db => {
    currentDb = nextDb;
    return currentDb;
  };

  return {
    kind: 'relicCljsRuntime',
    api,
    db: () => currentDb,
    snapshot: () => api.snapshot(currentDb),
    q: <Row = unknown>(query: unknown) => api.q<Row>(currentDb, query),
    transact: (transaction: unknown) => setDb(api.transact(currentDb, transaction)),
    trackTransact: <Row = unknown>(transaction: unknown) => {
      const result = api.trackTransact<Row>(currentDb, transaction);
      setDb(result.db);
      return result;
    },
    mat: (query: unknown) => setDb(api.mat(currentDb, query)),
    watch: (query: unknown) => setDb(api.watch(currentDb, query)),
    unwatch: (query: unknown) => setDb(api.unwatch(currentDb, query))
  };
}
