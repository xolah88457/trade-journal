import { db, folders } from "@/db";
import { bad, handler, ok } from "@/server/api";
import { reorderFolders } from "@/server/folders";
import { newId, nowIso } from "@/server/ids";

export const POST = handler(async (request: Request) => {
  const body: unknown = await request.json();
  const name = body && typeof body === "object" && "name" in body ? body.name : null;
  if (typeof name !== "string" || !name.trim()) return bad("Enter a folder name.");
  if (name.trim().length > 100) return bad("Folder names must be 100 characters or fewer.");
  const id = newId();
  db.insert(folders).values({ id, name: name.trim(), kind: "user", createdAt: nowIso() }).run();
  return ok({ id });
});

/** Saves the sidebar order: `{ order: string[] }` lists folder ids top to bottom. */
export const PUT = handler(async (request: Request) => {
  const body: unknown = await request.json();
  const order = body && typeof body === "object" && "order" in body ? body.order : null;
  if (
    !Array.isArray(order) ||
    order.length > 1000 ||
    !order.every((id): id is string => typeof id === "string")
  ) {
    return bad("Send the folder order as a list of folder ids.");
  }
  return ok({ order: reorderFolders(order) });
});
