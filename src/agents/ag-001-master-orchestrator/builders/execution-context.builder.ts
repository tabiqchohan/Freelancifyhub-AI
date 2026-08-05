import type { ExecutionContext } from '../interfaces/index.js';
import type { RequestContext } from '../interfaces/index.js';
import { nowIso } from '../utils/ids.js';

/** Fluent builder producing an immutable {@link ExecutionContext}. */
export class ExecutionContextBuilder<State = Readonly<Record<string, unknown>>> {
  private agentId = '';
  private context!: RequestContext;
  private state = {} as State;

  withAgentId(agentId: string): this {
    this.agentId = agentId;
    return this;
  }

  forRequest(context: RequestContext): this {
    this.context = context;
    return this;
  }

  withState(state: State): this {
    this.state = state;
    return this;
  }

  build(): ExecutionContext<State> {
    return {
      agentId: this.agentId,
      traceId: this.context.traceId,
      requestId: this.context.requestId,
      startedAt: nowIso(),
      state: this.state,
    };
  }
}
