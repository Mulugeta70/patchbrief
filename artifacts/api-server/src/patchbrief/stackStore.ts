import { asc, count, eq, sql } from "drizzle-orm";
import { db, stackItemsTable, stackStateTable } from "@workspace/db";

const examples = [
  { name: "node", version: "18" },
  { name: "express", version: "4.17.1" },
  { name: "lodash", version: "4.17.20" },
  { name: "postgres", version: "15" },
];
export const MAX_STACK_ITEMS = 30;

export async function seedExampleStack() {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(284719054)`);
    const seeded = await tx.insert(stackStateTable).values({ key: "examples_seeded" })
      .onConflictDoNothing().returning();
    if (!seeded.length) return;
    const [existing] = await tx.select({ total: count() }).from(stackItemsTable);
    if (existing?.total === 0) await tx.insert(stackItemsTable).values(examples);
  });
}

export function listStackItems() {
  return db.select().from(stackItemsTable).orderBy(asc(stackItemsTable.name));
}

export async function addStackItem(name: string, version: string) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(284719054)`);
    const [existing] = await tx.select().from(stackItemsTable).where(eq(stackItemsTable.name, name));
    if (existing) return { error: "That software is already in the stack. Remove it before adding a different version." } as const;
    const [size] = await tx.select({ total: count() }).from(stackItemsTable);
    if ((size?.total ?? 0) >= MAX_STACK_ITEMS) {
      return { error: "The stack is limited to 30 items. Remove an item before adding another." } as const;
    }
    const [item] = await tx.insert(stackItemsTable).values({ name, version }).returning();
    if (!item) throw new Error("Stack item could not be saved.");
    return { item } as const;
  });
}

export async function deleteStackItem(id: string) {
  const deleted = await db.delete(stackItemsTable).where(eq(stackItemsTable.id, id)).returning();
  return deleted.length > 0;
}
