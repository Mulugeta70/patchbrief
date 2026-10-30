import { pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const stackItemsTable = pgTable(
  "stack_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    version: text("version").notNull(),
  },
  (table) => [uniqueIndex("stack_items_name_unique").on(table.name)],
);

export type StackItem = typeof stackItemsTable.$inferSelect;
