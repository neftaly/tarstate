import type { JsonValue } from '@tarstate/core';
import type { AutomergePath } from '../document/projection.js';

export type AutomergeMappedStorageRow = {
  readonly relationId: string;
  readonly key: readonly [JsonValue, ...JsonValue[]];
  readonly fields: Readonly<Record<string, JsonValue>>;
  readonly locator: {
    readonly namespace: string;
    readonly token: JsonValue;
    readonly rowIncarnation: string;
  };
  readonly storagePath: AutomergePath;
};
