/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { inject, injectable } from 'inversify';
import Cdp from '../cdp/api';
import { truthy } from '../common/objUtils';
import Dap from '../dap/api';
import { IEvaluator, PreparedCallFrameExpr } from './evaluator';
import { ScriptSkipper } from './scriptSkipper/implementation';
import { IScriptSkipper } from './scriptSkipper/scriptSkipper';

export interface IExceptionPauseService {
  /**
   * Updates the breakpoint pause state in the service.
   */
  setBreakpoints(params: Dap.SetExceptionBreakpointsParams): Promise<void>;

  /**
   * Gets whether the exception pause service would like the debugger to
   * remain paused at the given point. Will return false if the event is
   * not an exception pause.
   */
  shouldPauseAt(evt: Cdp.Debugger.PausedEvent): Promise<boolean>;

  /**
   * Applies the exception pause service to the CDP connection. This should
   * be called only after the Debugger domain has been enabled.
   */
  apply(cdp: Cdp.Api): Promise<void>;
}

export const IExceptionPauseService = Symbol('IExceptionPauseService');

export const enum PauseOnExceptionsState {
  None = 'none',
  All = 'all',
  Uncaught = 'uncaught',
}

type ActivePause = {
  cdp: PauseOnExceptionsState.All | PauseOnExceptionsState.Uncaught;
  condition: { caught?: PreparedCallFrameExpr; uncaught?: PreparedCallFrameExpr };
};

/**
 * Internal representation of set exception breakpoints. For conditional
 * exception breakpoints, we instruct CDP to pause on all exceptions, but
 * then run expressions and check their truthiness to figure out if we
 * should actually stop.
 */
type PauseOnExceptions = { cdp: PauseOnExceptionsState.None } | ActivePause;

@injectable()
export class ExceptionPauseService implements IExceptionPauseService {
  private state: PauseOnExceptions = { cdp: PauseOnExceptionsState.None };
  private cdp?: Cdp.Api;

  constructor(
    @inject(IEvaluator) private evaluator: IEvaluator,
    @inject(IScriptSkipper) private scriptSkipper: ScriptSkipper,
  ) {}

  /**
   * @inheritdoc
   */
  public async setBreakpoints(params: Dap.SetExceptionBreakpointsParams) {
    this.state = this.parseBreakpointRequest(params);
    if (this.cdp) {
      await this.cdp.Debugger.setPauseOnExceptions({ state: this.state.cdp });
    }
  }

  /**
   * @inheritdoc
   */
  public async shouldPauseAt(evt: Cdp.Debugger.PausedEvent) {
    if (evt.reason !== 'exception' || this.state.cdp === PauseOnExceptionsState.None) {
      return false;
    }

    if (this.shouldScriptSkip(evt)) {
      return false;
    }

    const cond = this.state.condition;
    if (evt.data?.uncaught) {
      if (cond.uncaught && !(await this.evalCondition(evt, cond.uncaught))?.result.value) {
        return false;
      }
    } else if (cond.caught) {
      if (!(await this.evalCondition(evt, cond.caught))?.result.value) {
        return false;
      }
    }

    return true;
  }

  /**
   * @inheritdoc
   */
  public async apply(cdp: Cdp.Api) {
    this.cdp = cdp;
    if (this.state.cdp !== PauseOnExceptionsState.None) {
      await this.cdp.Debugger.setPauseOnExceptions({ state: this.state.cdp });
    }
  }

  private evalCondition(evt: Cdp.Debugger.PausedEvent, method: PreparedCallFrameExpr) {
    return method({ callFrameId: evt.callFrames[0].callFrameId }, { error: evt.data });
  }

  /**
   * Setting blackbox patterns is asynchronous to when the source is loaded,
   * so if the user asks to pause on exceptions the runtime may pause in a
   * place where we don't want it to. Double check at this point and manually
   * resume debugging for handled exceptions. This implementation seems to
   * work identically to blackboxing (test cases represent this):
   *
   * - ✅ An error is thrown and caught within skipFiles. Resumed here.
   * - ✅ An uncaught error is re/thrown within skipFiles. In both cases the
   *      stack is reported at the first non-skipped file is shown.
   * - ✅ An error is thrown from skipFiles and caught in user code. In both
   *      blackboxing and this version, the debugger will not pause.
   * - ✅ An error is thrown anywhere in user code. All good.
   *
   * See: https://github.com/microsoft/vscode-js-debug/issues/644
   */
  private shouldScriptSkip(evt: Cdp.Debugger.PausedEvent) {
    return (
      !evt.data?.uncaught &&
      evt.callFrames.length &&
      this.scriptSkipper.isScriptSkipped(evt.callFrames[0].url)
    );
  }

  /**
   * Parses the breakpoint request into the "PauseOnException" type for easier
   * handling internally.
   */
  protected parseBreakpointRequest(params: Dap.SetExceptionBreakpointsParams): PauseOnExceptions {
    const filters = (params.filterOptions ?? []).concat(
      params.filters.map(filterId => ({ filterId })),
    );

    let cdp = PauseOnExceptionsState.None;
    const caughtConditions: string[] = [];
    const uncaughtConditions: string[] = [];

    for (const { filterId, condition } of filters) {
      if (filterId === PauseOnExceptionsState.All) {
        cdp = PauseOnExceptionsState.All;
        if (condition) {
          caughtConditions.push(filterId);
        }
      } else if (filterId === PauseOnExceptionsState.Uncaught) {
        if (cdp === PauseOnExceptionsState.None) {
          cdp = PauseOnExceptionsState.Uncaught;
        }
        if (condition) {
          uncaughtConditions.push(filterId);
        }
      }
    }

    const compile = (condition: string[]) =>
      condition.length === 0
        ? undefined
        : this.evaluator.prepare(
            '!!(' +
              filters
                .map(f => f.condition)
                .filter(truthy)
                .join(') || !!(') +
              ')',
            {
              hoist: ['error'],
            },
          ).invoke;

    if (cdp === PauseOnExceptionsState.None) {
      return { cdp };
    } else {
      return {
        cdp,
        condition: { caught: compile(caughtConditions), uncaught: compile(uncaughtConditions) },
      };
    }
  }
}