import * as relic from '../dist/cljs/relic.js';

const selectedUsers = [
  [':from', ':User'],
  [':where', ':selected']
];

let db = relic.createDb({
  User: [
    { user: 'alice', selected: false },
    { user: 'bob', selected: false }
  ]
});

db = relic.watch(db, selectedUsers);
const result = relic.trackTransact(db, [
  ':insert',
  ':User',
  { user: 'cara', selected: true }
]);

console.log(JSON.stringify({
  selected: relic.q(result.db, selectedUsers),
  changes: result.changes
}, null, 2));
