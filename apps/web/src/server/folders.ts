import { asc, eq, isNull, sql } from "drizzle-orm";
import { db, folders } from "@/db";

/**
 * Sidebar order: folders the user placed come first by position; the rest (built-ins
 * and folders created since the last reorder) follow in creation order. rowid breaks
 * ties between built-ins seeded with the same timestamp, keeping their seed order.
 */
export const folderOrder = [
  sql`${folders.position} IS NULL`,
  asc(folders.position),
  asc(folders.createdAt),
  sql`${folders}.rowid`,
];

export const listFolders = () =>
  db
    .select()
    .from(folders)
    .where(isNull(folders.deletedAt))
    .orderBy(...folderOrder)
    .all();

/**
 * Stores a new sidebar order. `ids` lists folders in their new order; unknown,
 * removed and duplicate ids are skipped, and folders it leaves out keep their
 * relative order after the listed ones, so a stale client cannot lose a folder.
 * "All notes" is not a folder in the list and is never positioned.
 */
export const reorderFolders = (ids: readonly string[]): string[] =>
  db.transaction((tx) => {
    const live = tx
      .select({ id: folders.id })
      .from(folders)
      .where(isNull(folders.deletedAt))
      .orderBy(...folderOrder)
      .all()
      .map((row) => row.id)
      .filter((id) => id !== "all");
    const known = new Set(live);
    const listed = [...new Set(ids)].filter((id) => known.has(id));
    const placed = new Set(listed);
    const order = [...listed, ...live.filter((id) => !placed.has(id))];
    order.forEach((id, position) =>
      tx.update(folders).set({ position }).where(eq(folders.id, id)).run(),
    );
    return order;
  });
