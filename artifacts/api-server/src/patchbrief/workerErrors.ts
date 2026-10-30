export class WorkerCrashError extends Error {
  constructor() {
    super("Injected worker crash. This run will resume after its lease expires.");
    this.name = "WorkerCrashError";
  }
}

export class LeaseLostError extends Error {
  constructor() {
    super("Worker lease was lost; stale worker stopped without saving results.");
    this.name = "LeaseLostError";
  }
}

export function isWorkerStop(error: unknown): boolean {
  return error instanceof WorkerCrashError || error instanceof LeaseLostError;
}
