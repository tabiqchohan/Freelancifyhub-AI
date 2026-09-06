import { describe, expect, it } from 'vitest';

import {
  AgenticLoopStateMachine,
  AGENTIC_TERMINAL_STATES,
} from '../../../../../src/agents/runtime/agentic/state.js';
import { AgenticLoopState } from '../../../../../src/agents/runtime/agentic/contracts.js';
import { AgenticStateTransitionError } from '../../../../../src/agents/runtime/agentic/errors.js';

describe('agentic state machine (Sprint 18)', () => {
  it('starts idle and allows the expected happy-path lifecycle', () => {
    const machine = new AgenticLoopStateMachine();
    expect(machine.state).toBe(AgenticLoopState.Idle);
    expect(machine.terminal).toBe(false);

    machine.transition(AgenticLoopState.Reasoning);
    machine.transition(AgenticLoopState.ToolValidating);
    machine.transition(AgenticLoopState.ToolExecuting);
    machine.transition(AgenticLoopState.ToolResultProcessing);
    machine.transition(AgenticLoopState.Completed);

    expect(machine.state).toBe(AgenticLoopState.Completed);
    expect(machine.terminal).toBe(true);
  });

  it('supports the tool-validation feedback edge into Reasoning', () => {
    const machine = new AgenticLoopStateMachine();
    machine.transition(AgenticLoopState.Reasoning);
    machine.transition(AgenticLoopState.ToolValidating);
    expect(machine.can(AgenticLoopState.Reasoning)).toBe(true);
    machine.transition(AgenticLoopState.Reasoning);
    expect(machine.state).toBe(AgenticLoopState.Reasoning);
  });

  it('supports reaching every terminal outcome from Reasoning', () => {
    for (const terminal of [
      AgenticLoopState.Completed,
      AgenticLoopState.Clarification,
      AgenticLoopState.Failed,
      AgenticLoopState.Cancelled,
      AgenticLoopState.TimedOut,
      AgenticLoopState.LimitReached,
    ]) {
      const machine = new AgenticLoopStateMachine();
      machine.transition(AgenticLoopState.Reasoning);
      machine.transition(terminal);
      expect(machine.state).toBe(terminal);
    }
  });

  it('rejects illegal transitions deterministically', () => {
    const machine = new AgenticLoopStateMachine();
    expect(() => machine.transition(AgenticLoopState.Completed)).toThrow(
      AgenticStateTransitionError,
    );
    expect(machine.state).toBe(AgenticLoopState.Idle);

    machine.transition(AgenticLoopState.Reasoning);
    expect(() => machine.transition(AgenticLoopState.ToolExecuting)).toThrow(
      AgenticStateTransitionError,
    );
    expect(() => machine.transition(AgenticLoopState.Idle)).toThrow(AgenticStateTransitionError);
  });

  it('treats terminal states as absorbing', () => {
    const machine = new AgenticLoopStateMachine();
    machine.transition(AgenticLoopState.Reasoning);
    machine.transition(AgenticLoopState.Completed);
    expect(() => machine.transition(AgenticLoopState.Reasoning)).toThrow(
      AgenticStateTransitionError,
    );
  });

  it('treats re-entering the same state as a no-op', () => {
    const machine = new AgenticLoopStateMachine();
    machine.transition(AgenticLoopState.Reasoning);
    expect(machine.transition(AgenticLoopState.Reasoning)).toBe(AgenticLoopState.Reasoning);
    expect(machine.state).toBe(AgenticLoopState.Reasoning);
  });

  it('exposes all absorbing states as terminal', () => {
    for (const state of AGENTIC_TERMINAL_STATES) {
      const machine = new AgenticLoopStateMachine();
      machine.transition(AgenticLoopState.Reasoning);
      machine.transition(state);
      expect(machine.terminal).toBe(true);
    }
  });
});
