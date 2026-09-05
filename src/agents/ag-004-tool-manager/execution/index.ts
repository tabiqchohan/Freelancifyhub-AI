export { ToolExecutor } from './executor.js';
export type { ToolExecutorOptions } from './executor.js';

/** Semantic entrypoint: create() remains a simple constructor alias. */
import { ToolExecutor } from './executor.js';
import type { ToolExecutorOptions } from './executor.js';

export function createToolExecutor(options: ToolExecutorOptions): ToolExecutor {
  return new ToolExecutor(options);
}
