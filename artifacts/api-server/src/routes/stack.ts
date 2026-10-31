import { Router, type IRouter } from "express";
import { AddStackItemBody, DeleteStackItemParams } from "@workspace/api-zod";
import { addStackItem, deleteStackItem, listStackItems } from "../patchbrief/stackStore";
import { requireStackEditKey } from "../middlewares/stackEditGuard";
import { isDottedVersion, VERSION_MESSAGE } from "../patchbrief/stackValidation";

const router: IRouter = Router();
router.get("/stack", async (_req, res, next) => {
  try { res.json(await listStackItems()); } catch (error) { next(error); }
});
router.post("/stack/unlock", requireStackEditKey, (_req, res) => { res.status(204).end(); });
router.post("/stack", requireStackEditKey, async (req, res, next) => {
  if (typeof req.body?.version !== "string" || !isDottedVersion(req.body.version.trim())) {
    res.status(400).json({ error: VERSION_MESSAGE });
    return;
  }
  const body = AddStackItemBody.safeParse({
    name: typeof req.body?.name === "string" ? req.body.name.trim().toLowerCase() : req.body?.name,
    version: typeof req.body?.version === "string" ? req.body.version.trim() : req.body?.version,
  });
  if (!body.success || !/^[a-z0-9][a-z0-9 ._/@+-]*$/i.test(body.data.name)) {
    res.status(400).json({ error: "Enter a software name (1–80 characters)." });
    return;
  }
  try {
    const result = await addStackItem(body.data.name, body.data.version);
    if ("error" in result) { res.status(409).json({ error: result.error }); return; }
    res.status(201).json(result.item);
  } catch (error) { next(error); }
});
router.delete("/stack/:id", requireStackEditKey, async (req, res, next) => {
  const params = DeleteStackItemParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid stack item identifier. Refresh the list and try again." }); return; }
  try {
    if (!await deleteStackItem(params.data.id)) {
      res.status(404).json({ error: "That item has already been removed. Refresh the stack." }); return;
    }
    res.status(204).end();
  } catch (error) { next(error); }
});
export default router;
