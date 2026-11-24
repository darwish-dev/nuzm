import { decideExec, type ExecContext } from './policy';
import { MockExecutionPort } from './port';

/** The mock wired to the real policy core: it refuses exactly what `decideExec` refuses and executes nothing. */
export function createMockExecutionPort(ctx: ExecContext): MockExecutionPort {
  return new MockExecutionPort(decideExec, ctx);
}
