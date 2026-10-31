import { Router, type IRouter } from "express";
import {
  CreateRunBody,
  CreateRunHeader,
  CreateRunResponse,
  GetLatestRunResponse,
  GetRunParams,
  GetRunResponse,
  SubmitRunInputBody,
  SubmitRunInputParams,
  StreamRunEventsParams,
  isValidRunInput,
  RUN_INPUT_ERROR,
} from "@workspace/api-zod";
import {
  createRun,
  getLatestRunWithSteps,
  getRunWithSteps,
  resumeRunWithInput,
  listRecentRuns,
} from "../patchbrief/db";
import { subscribeToRun, type RunStreamEvent } from "../patchbrief/events";
import { wakeWorkers } from "../patchbrief/recovery";
import { runCreationRateLimit } from "../middlewares/runCreationRateLimit";

const router: IRouter = Router();

router.get("/runs", async (_req, res, next) => {
  try { res.json(await listRecentRuns()); } catch (error) { next(error); }
});

router.post("/runs", runCreationRateLimit, async (req, res, next): Promise<void> => {
  const parsedHeader = CreateRunHeader.safeParse({
    "Idempotency-Key": req.get("Idempotency-Key")?.trim(),
  });
  if (!parsedHeader.success) {
    res.status(400).json({ error: "A non-empty Idempotency-Key header is required." });
    return;
  }

  const rawInput =
    typeof req.body === "object" && req.body !== null
      ? (req.body as Record<string, unknown>)["input"]
      : undefined;
  if (typeof rawInput === "string" && rawInput.length > 20_000) {
    res.status(413).json({ error: "Input must be 20,000 characters or fewer." });
    return;
  }
  if (!isValidRunInput(rawInput)) {
    res.status(400).json({ error: RUN_INPUT_ERROR });
    return;
  }

  const parsedBody = CreateRunBody.safeParse(req.body);
  if (!parsedBody.success || parsedBody.data.input.trim().length === 0) {
    res.status(400).json({ error: "Invalid input or fault configuration. Supply non-empty input, valid fault types, and times of 1, 2, 3, or always." });
    return;
  }
  if (parsedBody.data.faults?.some((fault) =>
    fault.type !== "worker_crash" && !["fetch", "extract", "plan"].includes(fault.step))) {
    res.status(400).json({ error: "Network/JSON faults require fetch, extract, or plan. Worker crashes may target any step." });
    return;
  }

  try {
    const { run, created } = await createRun(
      parsedBody.data.input,
      parsedHeader.data["Idempotency-Key"],
      { faults: parsedBody.data.faults, slowMode: parsedBody.data.slowMode },
    );
    if (!created) {
      const existing = await getRunWithSteps(run.id);
      if (!existing) {
        res.status(500).json({ error: "The existing run could not be loaded." });
        return;
      }
      res.status(200).json(GetRunResponse.parse(existing));
      return;
    }

    void wakeWorkers();
    const createdRun = await getRunWithSteps(run.id);
    if (!createdRun) {
      res.status(500).json({ error: "The new run could not be loaded." });
      return;
    }
    res.status(201).json(CreateRunResponse.parse(createdRun));
  } catch (error) {
    next(error);
  }
});

router.get("/runs/latest", async (_req, res, next): Promise<void> => {
  try {
    const result = await getLatestRunWithSteps();
    if (!result) {
      res.status(404).json({ error: "No runs exist yet." });
      return;
    }
    res.json(GetLatestRunResponse.parse(result));
  } catch (error) {
    next(error);
  }
});

router.post("/runs/:id/input", async (req, res, next): Promise<void> => {
  const params = SubmitRunInputParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const rawInput =
    typeof req.body === "object" && req.body !== null
      ? (req.body as Record<string, unknown>)["input"]
      : undefined;
  if (typeof rawInput === "string" && rawInput.length > 20_000) {
    res.status(413).json({ error: "Input must be 20,000 characters or fewer." });
    return;
  }

  const parsedBody = SubmitRunInputBody.safeParse(req.body);
  if (!parsedBody.success || parsedBody.data.input.trim().length === 0) {
    res.status(400).json({ error: "Request body must include non-empty advisory text." });
    return;
  }

  try {
    const resumed = await resumeRunWithInput(
      params.data.id,
      parsedBody.data.input,
    );
    if (resumed.kind === "not_found") {
      res.status(404).json({ error: "Run not found." });
      return;
    }
    if (resumed.kind === "not_waiting") {
      res.status(409).json({ error: "This run is not waiting for advisory input." });
      return;
    }

    void wakeWorkers();
    const result = await getRunWithSteps(resumed.run.id);
    if (!result) {
      res.status(500).json({ error: "The resumed run could not be loaded." });
      return;
    }
    res.status(202).json(GetRunResponse.parse(result));
  } catch (error) {
    next(error);
  }
});

router.get("/runs/:id/events", async (req, res, next): Promise<void> => {
  const params = StreamRunEventsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const runId = params.data.id;
  const buffered: RunStreamEvent[] = [];
  let snapshotSent = false;
  let closed = false;
  let heartbeat: NodeJS.Timeout | undefined;

  const writeEvent = (name: string, data: unknown): void => {
    if (!closed && !res.writableEnded) {
      res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  };

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe();
  };

  const listener = (event: RunStreamEvent): void => {
    if (!snapshotSent) {
      buffered.push(event);
      return;
    }
    if (event.type === "step") writeEvent("step", event.step);
    else if (event.type === "attempt") writeEvent("attempt", event.attempt);
    else if (event.type === "fault") writeEvent("fault", event.fault);
    else writeEvent("run", event.run);
    if (
      event.type === "run" &&
      (event.run.status === "completed" || event.run.status === "failed")
    ) {
      res.end();
      cleanup();
    }
  };

  const unsubscribe = subscribeToRun(runId, listener);
  res.on("close", cleanup);

  try {
    const snapshot = await getRunWithSteps(runId);
    if (!snapshot) {
      cleanup();
      res.status(404).json({ error: "Run not found." });
      return;
    }

    res.status(200);
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    writeEvent("snapshot", snapshot);
    snapshotSent = true;

    const snapshotUpdatedAt = new Map(
      snapshot.steps.map((step) => [step.id, step.updatedAt.getTime()]),
    );
    for (const event of buffered) {
      if (
        event.type === "step" &&
        event.step.updatedAt.getTime() <
          (snapshotUpdatedAt.get(event.step.id) ?? Number.NEGATIVE_INFINITY)
      ) {
        continue;
      }
      if (event.type === "step") writeEvent("step", event.step);
      else if (event.type === "attempt") writeEvent("attempt", event.attempt);
      else if (event.type === "fault") writeEvent("fault", event.fault);
      else writeEvent("run", event.run);
      if (
        event.type === "run" &&
        (event.run.status === "completed" || event.run.status === "failed")
      ) {
        res.end();
        cleanup();
        return;
      }
    }
    buffered.length = 0;

    if (snapshot.run.finishedAt) {
      res.end();
      cleanup();
      return;
    }

    heartbeat = setInterval(() => {
      if (!closed && !res.writableEnded) res.write(": keepalive\n\n");
    }, 15_000);
  } catch (error) {
    cleanup();
    next(error);
  }
});

router.get("/runs/:id", async (req, res, next): Promise<void> => {
  const params = GetRunParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  try {
    const result = await getRunWithSteps(params.data.id);
    if (!result) {
      res.status(404).json({ error: "Run not found." });
      return;
    }
    res.json(GetRunResponse.parse(result));
  } catch (error) {
    next(error);
  }
});

export default router;
