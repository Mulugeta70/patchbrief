import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { pool } from "@workspace/db";

// Clone only table definitions into a disposable schema. The live recovery loop
// uses public, while every test connection uses only this schema (no fallback).
if (process.env.NODE_ENV === "production") {
  throw new Error("Run tests against the development database, not production.");
}
const schema = `patchbrief_test_${randomUUID().replaceAll("-", "")}`;
try {
  await pool.query(`CREATE SCHEMA "${schema}"`);
  for (const table of ["runs", "steps", "stack_items", "step_attempts", "run_faults"]) {
    await pool.query(`CREATE TABLE "${schema}"."${table}" (LIKE public."${table}" INCLUDING ALL)`);
  }
  // LIKE does not copy foreign keys; mirror the production cascade constraints.
  for (const table of ["steps", "step_attempts", "run_faults"]) {
    await pool.query(`ALTER TABLE "${schema}"."${table}" ADD FOREIGN KEY (run_id) REFERENCES "${schema}".runs(id) ON DELETE CASCADE`);
  }
  const scopedUrl = new URL(process.env.DATABASE_URL!);
  scopedUrl.searchParams.set("options", `-c search_path=${schema}`);
  const child = spawn(process.execPath, [
    "--import", "tsx", "--test",
    "src/patchbrief/reliability.test.ts",
    "src/patchbrief/worker.test.ts",
    "src/patchbrief/llm-limits.test.ts",
    "src/patchbrief/worker-integration.test.ts",
  ], {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: scopedUrl.toString(), PATCHBRIEF_MAX_RUNS_PER_DAY: "1000000" },
  });
  const stop = () => child.kill("SIGTERM");
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    process.exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
} finally {
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await pool.end();
}
