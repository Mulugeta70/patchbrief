import { claimExpiredRuns } from "./leases";
import { runPipeline } from "./runner";
import { logger } from "../lib/logger";

let claiming = false;
export async function wakeWorkers(): Promise<void> {
  if (claiming) return;
  claiming = true;
  try {
    const claimed = await claimExpiredRuns();
    for (const run of claimed) {
      void runPipeline(run).catch((error: unknown) =>
        logger.error({ err: error, runId: run.id }, "Worker failed; expired lease will be recovered"));
    }
  } catch (error) {
    logger.error({ err: error }, "Recovery scan failed");
  } finally {
    claiming = false;
  }
}

export async function startRecoveryLoop(): Promise<void> {
  await wakeWorkers();
  setInterval(() => { void wakeWorkers(); }, 2000).unref();
}
