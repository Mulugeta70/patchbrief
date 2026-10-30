import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { runsTable } from "./runs";

export type StepOutput = Record<string, unknown>;

export const stepsTable = pgTable(
  "steps",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runsTable.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    name: text("name").notNull(),
    status: text("status").notNull(),
    attempt: integer("attempt").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
    output: jsonb("output").$type<StepOutput>(),
    outputSummary: text("output_summary"),
    error: text("error"),
    fallbackUsed: boolean("fallback_used").notNull().default(false),
    interrupted: boolean("interrupted").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("steps_run_seq_unique").on(table.runId, table.seq),
    index("steps_run_id_index").on(table.runId),
  ],
);

export type Step = typeof stepsTable.$inferSelect;
