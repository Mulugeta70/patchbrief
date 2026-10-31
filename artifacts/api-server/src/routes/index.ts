import { Router, type IRouter } from "express";
import healthRouter from "./health";
import runsRouter from "./runs";
import stackRouter from "./stack";

const router: IRouter = Router();

router.use(healthRouter);
router.use(runsRouter);
router.use(stackRouter);

export default router;
