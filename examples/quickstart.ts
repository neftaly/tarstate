import {
  AttachmentCatalog,
  DatabaseView,
  DatasetMembership,
  createIncrementalDatabaseQueryMaintenance,
  prepareTypedQuery,
  prepareManualReadOnlyAttachment,
  relationLiteral,
  sealSchema,
  schemaLiteral,
  typedFrom,
  typedSelect,
  type ObservableSource,
  type RelationInput,
  type SourceSnapshot
} from '@tarstate/core';

const registryFingerprint = 'registry:quickstart';
const authorityFingerprint = 'authority:public';
const datasetId = 'menu';
const sourceId = 'source:pizzas';
const attachmentId = 'attachment:pizzas';

const schemaBody = schemaLiteral({
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
});
const schema = await sealSchema({
  id: 'example.pizza-ordering@1',
  body: schemaBody
});
const schemaView = { id: schema.id, contentHash: schema.contentHash };
const pizzaRows = [
  { name: 'margherita', price: 18 },
  { name: 'pepperoni', price: 21 }
] as const;

const pizzas = relationLiteral(schemaView, schemaBody, 'pizzas');
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

const attachments = new AttachmentCatalog();
const attachmentLease = attachments.attach({
  attachmentId,
  incarnation: 'attachment:pizzas:one',
  sourceId,
  source,
  authorityScope: 'public',
  discoveryEdges: [],
  preparation: prepareManualReadOnlyAttachment<Storage, readonly RelationInput[]>({
    schemaViewIds: [schemaView.id],
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
          relation: { schemaView, relationId: pizzas.relationId },
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
const membership = new DatasetMembership({
  datasetId,
  state: 'settled',
  members: [{
    attachmentId,
    sourceId,
    expectation: 'required',
    discoveryEdges: []
  }]
});
const database = new DatabaseView({
  authorityScope: 'public',
  authorityFingerprint,
  registryFingerprint,
  attachments,
  datasets: [membership],
  canRead: (viewScope, attachmentScope) => viewScope === attachmentScope,
  createQueryMaintenance: createIncrementalDatabaseQueryMaintenance()
});

const observer = database.observe({ plan: pizzaMenuPlan });
const result = observer.getSnapshot();
if (result.state !== 'open') throw new Error('Quickstart observer closed unexpectedly');
console.log(result.current.rows);

observer.close();
database.close();
attachmentLease.close();
