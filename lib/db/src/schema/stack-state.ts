import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Remembers initial seeding even when visitors deliberately remove every item.
export const stackStateTable = pgTable("stack_state", {
  key: text("key").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
