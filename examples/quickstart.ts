import {
  type ObservableSource,
  type SourceSnapshot
} from '@tarstate/core/database';
import {
  openDatabaseQuery,
  type MountableDatabaseSource
} from '@tarstate/core/database/session';
import { prepareManualReadOnlyAttachment } from '@tarstate/core/attachment/adapter';
import {
  prepareTypedQuery,
  typedFrom,
  typedSelect,
  type RelationInput
} from '@tarstate/core/query';
import { relationLiteral, sealSchema } from '@tarstate/core/schema';

const registryFingerprint = 'registry:quickstart';
const authorityFingerprint = 'authority:public';
const datasetId = 'menu';
const sourceId = 'source:pizzas';
const attachmentId = 'attachment:pizzas';

const schema = await sealSchema({
  id: 'example.pizza-ordering@1',
  body: {
    relations: {
      pizzas: {
        relationId: 'example.pizza',
        key: ['name'],
        fields: {
          name: { type: { kind: 'string' } },
          price: { type: { kind: 'number' } }
        }
      }
    }
  }
});
const pizzaRows = [
  { name: 'margherita', price: 18 },
  { name: 'pepperoni', price: 21 }
] as const;

const pizzas = relationLiteral(schema, 'pizzas');
const pizza = typedFrom(pizzas, 'pizza');
const pizzaMenuQuery = typedSelect(
  pizza,
  'menu',
  aliases => ({
    name: aliases.pizza.row.name,
    price: aliases.pizza.row.price
  })
);

const pizzaMenuPlan = await prepareTypedQuery(pizzaMenuQuery, {
  registryFingerprint,
  authorityFingerprint,
  datasetId
});

type Storage = { readonly pizzas: typeof pizzaRows };
const snapshot = (): SourceSnapshot<Storage> => ({
  sourceId,
  operationEpoch: 'epoch:quickstart',
  basis: { incarnation: 'pizzas:one', revision: 0 },
  state: 'ready',
  freshness: 'current',
  storage: { pizzas: pizzaRows },
  issues: []
});
const source: ObservableSource<Storage> = {
  sourceId,
  snapshot,
  subscribe: () => () => undefined
};

const databaseSource: MountableDatabaseSource = {
  mount: (catalog, options = {}) => {
    const discoveryEdges = Object.freeze([...(options.discoveryEdges ?? [])]);
    const lease = catalog.attach({
      attachmentId,
      incarnation: 'attachment:pizzas:one',
      sourceId,
      source,
      authorityScope: 'public',
      discoveryEdges,
      preparation: prepareManualReadOnlyAttachment<Storage, readonly RelationInput[]>({
        schemaViewIds: [schema.id],
        project: current => {
          if (current.storage === undefined) {
            return {
              state: current.state === 'ready' ? 'failed' : current.state,
              issues: current.issues
            };
          }
          return {
            state: 'ready',
            value: [{
              relation: { schemaView: pizzas.schemaView, relationId: pizzas.relationId },
              rows: current.storage.pizzas,
              occurrenceIds: current.storage.pizzas.map(row => `pizza:${row.name}`),
              completeness: 'exact',
              sourceId,
              attachmentId,
              basis: current.basis
            }],
            issues: []
          };
        }
      })
    });
    return {
      attachmentId,
      sourceId,
      discoveryEdges,
      close: () => lease.close()
    };
  }
};

const session = await openDatabaseQuery({
  sources: [{ source: databaseSource }],
  plan: pizzaMenuPlan,
  queryAuthorityScope: 'public'
});

const result = session.getSnapshot();
if (result.state !== 'open') throw new Error('Quickstart observer closed unexpectedly');
console.log(result.current.rows);

session.close();
