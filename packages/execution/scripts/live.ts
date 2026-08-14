import type { PendingExecutionEvent, RuntimeDependencies } from "../src/lib/ports.js";
import { productionDependencies } from "../src/lib/production.js";
import { ExecutionRuntime } from "../src/runtime.js";

export function liveRuntime(): ExecutionRuntime {
  const production = productionDependencies();
  const dependencies: RuntimeDependencies = {
    ...production,
    emitEvent: (runId: string, event: PendingExecutionEvent) => {
      process.stdout.write(`${JSON.stringify({ runId, ...event })}\n`);
    },
  };
  return new ExecutionRuntime(dependencies);
}
