import { Router, type IRouter } from "express";
import { createRun, getRunWithSteps } from "../patchbrief/db";
import { runPipeline } from "../patchbrief/runner";

const router: IRouter = Router();

router.post("/runs", async (req, res, next) => {
  const idempotencyKey = req.get("Idempotency-Key")?.trim();
  if (!idempotencyKey) {
    res.status(400).json({ error: "Idempotency-Key header is required." });
    return;
  }
  if (idempotencyKey.length > 200) {
    res.status(400).json({ error: "Idempotency-Key must be 200 characters or fewer." });
    return;
  }

  const input = req.body?.input;
  if (typeof input !== "string" || input.trim().length === 0) {
    res.status(400).json({ error: "Request body must include a non-empty input string." });
    return;
  }

  try {
    const { run, created } = await createRun(input, idempotencyKey);
    if (!created) {
      const existing = await getRunWithSteps(run.id);
      res.status(200).json(existing);
      return;
    }

    await runPipeline(run.id, input);
    const completed = await getRunWithSteps(run.id);
    res.status(201).json(completed);
  } catch (error) {
    next(error);
  }
});

router.get("/runs/:id", async (req, res, next) => {
  try {
    const result = await getRunWithSteps(req.params.id);
    if (!result) {
      res.status(404).json({ error: "Run not found." });
      return;
    }
    res.json(result);
  } catch (error) {
    next(error);
  }
});

export default router;
