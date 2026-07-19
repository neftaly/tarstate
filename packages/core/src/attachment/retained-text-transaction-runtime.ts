import type { DatabaseTransactionService } from '../database/transaction.js';
import type { StagedBasisAtomicSource } from '../source-protocol.js';
import { createRetainedTextPublicationDriver } from './retained-text-publication.js';
import type { TextIntentPublicationDriver } from './text-intent-service.js';
import type { RetainedTextPositionResolver } from './retained-text-positions.js';
import {
  prepareAttachmentTransactionService,
  type AttachmentTransactionServiceInput
} from './transaction-service.js';

type AttachmentPrivateBranch<Storage, Command> = ReturnType<
  StagedBasisAtomicSource<Storage, Command>['snapshot']
>;

export type AttachmentTransactionRuntime<Storage, Command> = {
  readonly transactions: DatabaseTransactionService;
  readonly retainedText?: TextIntentPublicationDriver<AttachmentPrivateBranch<Storage, Command>>;
};

export type AttachmentTransactionRuntimeInput<Storage, Command> =
  AttachmentTransactionServiceInput<Storage, Command> & {
    readonly textPositions?: RetainedTextPositionResolver<Storage>;
  };

/** Adds optional retained source-native text publication for adapter composition. */
export const createAttachmentTransactionRuntime = async <Storage, Command>(
  input: AttachmentTransactionRuntimeInput<Storage, Command>
): Promise<AttachmentTransactionRuntime<Storage, Command>> => {
  const prepared = await prepareAttachmentTransactionService(input);
  const retainedText = createRetainedTextPublicationDriver(
    input.source,
    prepared.context,
    prepared.prepareInput,
    [...prepared.capabilities.values()].some(({ fields }) =>
      Object.values(fields).some(({ textSplice }) => textSplice !== undefined)),
    input.textPositions
  );
  return Object.freeze({
    transactions: prepared.transactions,
    ...(retainedText === undefined ? {} : { retainedText })
  });
};
