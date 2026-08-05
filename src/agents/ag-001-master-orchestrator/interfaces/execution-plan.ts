import type { PipelineStageKind } from '../types/index.js';

/** A single schedulable unit inside an execution plan. */
export interface ExecutionStep {
  readonly id: string;
  readonly label?: string;
  readonly kind: PipelineStageKind;
}

/** An ordered plan of steps to be executed for a request. */
export interface ExecutionPlan {
  readonly id: string;
  readonly requestId: string;
  readonly stages: readonly ExecutionStep[];
}
