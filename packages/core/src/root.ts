/**
 * Minimal package root. Runtime features live at explicit topic entry points
 * such as `@tarstate/core/query`, `@tarstate/core/database`, and
 * `@tarstate/core/transactions` so importing one concern does not link all of
 * Tarstate in runtimes without tree shaking.
 */
export * from './canonical-json.js';
export * from './artifacts.js';
export * from './built-in-capability-declarations.js';
export * from './issues.js';
export * from './value.js';
