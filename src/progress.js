// Per-request progress channel. An SSE handler binds an emitter for the duration of a
// request; engine/planner/llm call emitStep() without any of them needing the emitter
// threaded through their signatures. No stream bound -> emitStep is a no-op.
import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage();

export const withProgress = (emit, fn) => als.run({ emit }, fn);

export function emitStep(event) {
  const store = als.getStore();
  if (store?.emit) { try { store.emit(event); } catch { /* client gone */ } }
}
