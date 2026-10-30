import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const runsTable = pgTable(
  "runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    idempotencyKey: text("idempotency_key").notNull(),
    input: text("input").notNull(),
    status: text("status").notNull().default("queued"),
    degraded: boolean("degraded").notNull().default(false),
    slowMode: boolean("slow_mode").notNull().default(false),
    resumeCount: integer("resume_count").notNull().default(0),
    workerId: text("worker_id"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }).defaultNow(),
    llmDisabledReason: text("llm_disabled_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("runs_idempotency_key_unique").on(table.idempotencyKey),
    index("runs_created_at_index").on(table.createdAt),
    index("runs_recovery_index").on(table.status, table.leaseExpiresAt),
  ],
);

export type Run = typeof runsTable.$inferSelect;
