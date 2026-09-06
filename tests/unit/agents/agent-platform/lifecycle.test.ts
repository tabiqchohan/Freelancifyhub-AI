import { describe, expect, it } from 'vitest';

import {
  AgentLifecycleController,
  AgentLifecycleState,
  AgentLifecycleStateMachine,
} from '../../../../src/agents/agent-platform/lifecycle.js';
import {
  AgentLifecycleInvalidError,
  AgentNotReadyError,
  AgentTerminatedError,
} from '../../../../src/agents/agent-platform/errors.js';

describe('AgentLifecycleStateMachine', () => {
  it('starts Registered and follows the documented path to Ready', () => {
    const machine = new AgentLifecycleStateMachine();
    expect(machine.current).toBe(AgentLifecycleState.Registered);
    machine.transition(AgentLifecycleState.Initializing);
    machine.transition(AgentLifecycleState.Ready);
    expect(machine.current).toBe(AgentLifecycleState.Ready);
  });

  it('rejects invalid transitions', () => {
    const machine = new AgentLifecycleStateMachine();
    expect(() => machine.transition(AgentLifecycleState.Terminated)).not.toThrow();
    const terminal = new AgentLifecycleStateMachine(AgentLifecycleState.Terminated);
    expect(terminal.canTransition(AgentLifecycleState.Ready)).toBe(false);
    expect(() => terminal.transition(AgentLifecycleState.Ready)).toThrow(
      AgentLifecycleInvalidError,
    );
  });
});

describe('AgentLifecycleController', () => {
  it('registers, initializes, activates and unregisters', () => {
    const controller = new AgentLifecycleController();
    controller.register('AG-101');
    expect(controller.stateOf('AG-101')).toBe(AgentLifecycleState.Registered);
    controller.activate('AG-101');
    expect(controller.stateOf('AG-101')).toBe(AgentLifecycleState.Ready);
    expect(controller.isRoutable('AG-101')).toBe(true);
    expect(controller.unregister('AG-101')).toBe(true);
    expect(controller.isRegistered('AG-101')).toBe(false);
  });

  it('register rejects duplicates', () => {
    const controller = new AgentLifecycleController();
    controller.register('AG-101');
    expect(() => controller.register('AG-101')).toThrow(/already registered/);
  });

  it('transitions pause/resume', () => {
    const controller = new AgentLifecycleController();
    controller.register('AG-101');
    controller.activate('AG-101');
    controller.pause('AG-101');
    expect(controller.stateOf('AG-101')).toBe(AgentLifecycleState.Paused);
    expect(controller.isRoutable('AG-101')).toBe(false);
    controller.resume('AG-101');
    expect(controller.stateOf('AG-101')).toBe(AgentLifecycleState.Ready);
  });

  it('drain auto-disables when no executions are active', () => {
    const controller = new AgentLifecycleController();
    controller.register('AG-101');
    controller.activate('AG-101');
    controller.drain('AG-101');
    expect(controller.stateOf('AG-101')).toBe(AgentLifecycleState.Disabled);
    expect(controller.isReady('AG-101')).toBe(false);
  });

  it('disable refuses while executions are in flight', () => {
    const controller = new AgentLifecycleController();
    controller.register('AG-101');
    controller.activate('AG-101');
    controller.beginExecution('AG-101');
    expect(() => controller.disable('AG-101')).toThrow(/active executions/);
    controller.endExecution('AG-101');
    controller.disable('AG-101');
    expect(controller.stateOf('AG-101')).toBe(AgentLifecycleState.Disabled);
  });

  it('fail and recover', () => {
    const controller = new AgentLifecycleController();
    controller.register('AG-101');
    controller.activate('AG-101');
    controller.fail('AG-101');
    expect(controller.stateOf('AG-101')).toBe(AgentLifecycleState.Failed);
    controller.recover('AG-101');
    expect(controller.stateOf('AG-101')).toBe(AgentLifecycleState.Initializing);
    controller.activate('AG-101');
    expect(controller.stateOf('AG-101')).toBe(AgentLifecycleState.Ready);
  });

  it('terminate is final; activate from terminated is rejected', () => {
    const controller = new AgentLifecycleController();
    controller.register('AG-101');
    controller.terminate('AG-101');
    expect(controller.stateOf('AG-101')).toBe(AgentLifecycleState.Terminated);
    expect(() => controller.activate('AG-101')).toThrow(AgentLifecycleInvalidError);
  });

  it('beginExecution gates on lifecycle and tracks concurrency', () => {
    const controller = new AgentLifecycleController();
    controller.register('AG-101');
    expect(() => controller.beginExecution('AG-101')).toThrow(AgentNotReadyError);
    controller.activate('AG-101');
    controller.beginExecution('AG-101');
    controller.beginExecution('AG-101');
    expect(controller.activeExecutionCount('AG-101')).toBe(2);
    controller.endExecution('AG-101');
    expect(controller.activeExecutionCount('AG-101')).toBe(1);
    controller.endExecution('AG-101');
    controller.endExecution('AG-101');
    expect(controller.activeExecutionCount('AG-101')).toBe(0);
  });

  it('returns to Ready when the last execution completes', () => {
    const controller = new AgentLifecycleController();
    controller.register('AG-101');
    controller.activate('AG-101');
    controller.beginExecution('AG-101');
    expect(controller.stateOf('AG-101')).toBe(AgentLifecycleState.Running);
    controller.endExecution('AG-101');
    expect(controller.stateOf('AG-101')).toBe(AgentLifecycleState.Ready);
  });

  it('disabled/terminated agents reject new executions with typed errors', () => {
    const disabled = new AgentLifecycleController();
    disabled.register('AG-101');
    disabled.activate('AG-101');
    disabled.disable('AG-101');
    expect(() => disabled.beginExecution('AG-101')).toThrow(/disabled/);

    const terminated = new AgentLifecycleController();
    terminated.register('AG-101');
    terminated.terminate('AG-101');
    expect(() => terminated.beginExecution('AG-101')).toThrow(AgentTerminatedError);
  });

  it('summary reflects per-state counts and active executions', () => {
    const controller = new AgentLifecycleController();
    controller.register('AG-101');
    controller.activate('AG-101');
    controller.register('AG-102');
    controller.beginExecution('AG-101');
    const summary = controller.summary();
    expect(summary.states[AgentLifecycleState.Ready]).toBe(0);
    expect(summary.states[AgentLifecycleState.Running]).toBe(1);
    expect(summary.states[AgentLifecycleState.Registered]).toBe(1);
    expect(summary.activeExecutions).toBe(1);
  });
});
