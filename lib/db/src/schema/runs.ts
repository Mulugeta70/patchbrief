import {
  boolean,
  index,
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
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("runs_idempotency_key_unique").on(table.idempotencyKey),
    index("runs_created_at_index").on(table.createdAt),
  ],
);

export type Run = typeof runsTable.$inferSelect;
