import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { runsTable } from "./runs";

export const runFaultsTable = pgTable("run_faults", {
  id: uuid("id").defaultRandom().primaryKey(),
  runId: uuid("run_id").notNull().references(() => runsTable.id, { onDelete: "cascade" }),
  stepName: text("step_name").notNull(),
  seq: integer("seq").notNull().default(0),
  type: text("type").notNull(),
  remaining: integer("remaining").notNull(),
  initialTimes: integer("initial_times").notNull(),
  injectedCount: integer("injected_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index("run_faults_run_step_index").on(table.runId, table.stepName)]);

export type RunFault = typeof runFaultsTable.$inferSelect;
