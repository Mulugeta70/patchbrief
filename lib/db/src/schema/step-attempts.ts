import {
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { runsTable } from "./runs";

export const stepAttemptsTable = pgTable(
  "step_attempts",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => runsTable.id, { onDelete: "cascade" }),
    stepName: text("step_name").notNull(),
    attempt: integer("attempt").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    durationMs: integer("duration_ms"),
    error: text("error"),
    retryInMs: integer("retry_in_ms"),
    status: text("status").notNull().default("running"),
    faultType: text("fault_type"),
  },
  (table) => [
    primaryKey({
      name: "step_attempts_pk",
      columns: [table.runId, table.stepName, table.attempt],
    }),
  ],
);

export type StepAttempt = typeof stepAttemptsTable.$inferSelect;
