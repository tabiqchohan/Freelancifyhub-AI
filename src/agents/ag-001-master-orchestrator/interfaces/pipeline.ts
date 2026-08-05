import type { ErrorInfo } from '../types/index.js';
import type { ExecutionStatus } from '../types/index.js';
import type { PipelineStageKind } from '../types/index.js';

/** A declarative pipeline step abstraction (interface only, no execution). */
export interface PipelineStep<I = unknown, O = unknown> {
  readonly id: string;
  readonly name: string;
  execute(input: I): Promise<O>;
}

/** A named collection of pipeline steps sharing a slot and purpose. */
export interface PipelineStage {
  readonly name: string;
  readonly kind: PipelineStageKind;
  readonly steps: readonly PipelineStep[];
}

/** Per-stage outcome recorded during a pipeline run. */
export interface PipelineStageResult {
  readonly stage: string;
  readonly kind: PipelineStageKind;
  readonly state: ExecutionStatus;
  readonly error?: ErrorInfo;
}

/** Aggregate outcome of running a pipeline (interface only). */
export interface PipelineResult<R = unknown> {
  readonly success: boolean;
  readonly stages: readonly PipelineStageResult[];
  readonly result?: R;
  readonly error?: ErrorInfo;
}

/** Executes a sequence of pipeline stages (interface only, sprint 1). */
export interface PipelineExecutor<R = unknown> {
  readonly stages: readonly PipelineStage[];
  execute(stages?: readonly PipelineStage[]): Promise<PipelineResult<R>>;
}
