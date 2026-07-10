declare const pipeOperatorType: unique symbol;

export interface PipeType {
  readonly input: unknown;
  readonly output: unknown;
  readonly accepts: boolean;
}

export type PipeOperator<Type extends PipeType> = {
  readonly [pipeOperatorType]: Type;
};

export type PipeApplication<Operator, Input> = Operator extends PipeOperator<infer Type>
  ? Type & { readonly input: Input }
  : never;
