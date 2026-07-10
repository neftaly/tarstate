const thresholds = {
  types: 75_000,
  instantiations: 150_000,
  memoryKilobytes: 300_000
};

let diagnostics = '';
for await (const chunk of process.stdin) diagnostics += chunk;
process.stdout.write(diagnostics);

if (/\berror TS\d+:/u.test(diagnostics)) {
  throw new Error('Type budget fixture failed to compile');
}

const measured = {
  types: readMetric('Types'),
  instantiations: readMetric('Instantiations'),
  memoryKilobytes: readMetric('Memory used', 'K')
};
const failures = Object.entries(measured).filter(([name, value]) => value > thresholds[name]);
if (failures.length > 0) {
  throw new Error(`Type budget exceeded: ${failures.map(([name, value]) => `${name}=${value} > ${thresholds[name]}`).join(', ')}`);
}
process.stdout.write(`${JSON.stringify({ fixture: 'core/type-fixtures/authoring-budget.ts', counterSource: 'TypeScript 7 extended diagnostics', measured, thresholds })}\n`);

function readMetric(label, suffix = '') {
  const match = diagnostics.match(new RegExp(`^${label}:\\s+(\\d+)${suffix}$`, 'mu'));
  if (match?.[1] === undefined) throw new Error(`TypeScript did not report ${label}`);
  return Number(match[1]);
}
