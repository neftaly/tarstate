import type { TarstateDiagnostic } from './diagnostics.js';

const stubMessage = 'tarstate implementation has been removed; regenerate this API implementation';

export function stubbed(name: string): never {
  throw new Error(`${name}: ${stubMessage}`);
}

export function stubDiagnostic(surface: string): TarstateDiagnostic {
  return {
    code: 'unsupported_expression',
    message: `${surface}: ${stubMessage}`,
    detail: { surface }
  };
}
