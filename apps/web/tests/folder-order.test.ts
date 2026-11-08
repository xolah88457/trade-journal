import { afterAll, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

const previous = process.env.JOURNAL_DATA_DIR;
const scratch = mkdtempSync(join(tmpdir(), "journal-folder-order-"));
process.env.JOURNAL_DATA_DIR = scratch;
vi.stubEnv("JOURNAL_PASSWORD", "");
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
// A journal from before folder ordering: no position column yet, one custom folder.
const legacy = new Database(join(scratch, "journal.db"));
legacy.exec(`CREATE TABLE folders (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL, deleted_at TEXT
);
INSERT INTO folders (id, name, kind, created_at) VALUES
  ('all', 'All notes', 'system', '2026-01-01T00:00:00Z'),
  ('trade-notes', 'Trade notes', 'system', '2026-01-01T00:00:00Z'),
  ('daily-journal', 'Daily journal', 'system', '2026-01-01T00:00:00Z'),
  ('session-recaps', 'Session recaps', 'system', '2026-01-01T00:00:00Z'),
  ('my-notes', 'My notes', 'system', '2026-01-01T00:00:00Z'),
  ('core', 'Core Content', 'user', '2026-03-01T00:00:00Z');`);
legacy.close();
const { db, folders } = await import("../src/db");
const { POST, PUT } = await import("../src/app/api/folders/route");
const { DELETE } = await import("../src/app/api/folders/[id]/route");
const { GET } = await import("../src/app/api/notes/route");
const { applyFolderOrder } = await import("../src/app/notebook/folder-list");

const listed = async (): Promise<string[]> =>
  (
    (await (await GET(new Request("http://localhost/api/notes"))).json()).folders as {
      id: string;
    }[]
  )
    .map((folder) => folder.id)
    .filter((id) => id !== "all");
const reorder = (order: unknown) =>
  PUT(
    new Request("http://localhost/api/folders", { method: "PUT", body: JSON.stringify({ order }) }),
  );

it("keeps the existing sidebar order for journals that were never reordered", async () => {
  expect(await listed()).toEqual([
    "trade-notes",
    "daily-journal",
    "session-recaps",
    "my-notes",
    "core",
  ]);
});

it("moves a folder to the top and keeps that order", async () => {
  const response = await reorder([
    "core",
    "trade-notes",
    "daily-journal",
    "session-recaps",
    "my-notes",
  ]);
  expect(response.status).toBe(200);
  expect(await listed()).toEqual([
    "core",
    "trade-notes",
    "daily-journal",
    "session-recaps",
    "my-notes",
  ]);
  expect(db.select().from(folders).where(eq(folders.id, "core")).get()?.position).toBe(0);
});

it("adds new folders at the bottom of a reordered sidebar", async () => {
  const created = await (
    await POST(
      new Request("http://localhost/api/folders", {
        method: "POST",
        body: JSON.stringify({ name: "PA Breakdown" }),
      }),
    )
  ).json();
  expect((await listed()).at(-1)).toBe(created.id);
  expect((await listed())[0]).toBe("core");
});

it("ignores unknown, duplicate and removed ids and keeps folders a stale order leaves out", async () => {
  const before = await listed();
  await DELETE(new Request("http://localhost/api/folders/session-recaps", { method: "DELETE" }), {
    params: Promise.resolve({ id: "session-recaps" }),
  });
  const response = await reorder(["my-notes", "missing", "session-recaps", "my-notes", "all"]);
  expect(response.status).toBe(200);
  const expected = [
    "my-notes",
    ...before.filter((id) => id !== "my-notes" && id !== "session-recaps"),
  ];
  expect((await response.json()).order).toEqual(expected);
  expect(await listed()).toEqual(expected);
  expect(db.select().from(folders).where(eq(folders.id, "all")).get()?.position).toBeNull();
});

it.each([null, "core", [1, 2], { 0: "core" }])("rejects a malformed order %j", async (order) => {
  const before = await listed();
  expect((await reorder(order)).status).toBe(400);
  expect(await listed()).toEqual(before);
});

it("applies a pending order on the client, keeping folders it does not know at the end", () => {
  const rows = ["a", "b", "c", "d"].map((id) => ({ id }));
  expect(applyFolderOrder(rows, ["c", "a"]).map((row) => row.id)).toEqual(["c", "a", "b", "d"]);
  expect(applyFolderOrder(rows, null).map((row) => row.id)).toEqual(["a", "b", "c", "d"]);
});

afterAll(() => {
  db.$client.close();
  vi.unstubAllEnvs();
  if (previous === undefined) delete process.env.JOURNAL_DATA_DIR;
  else process.env.JOURNAL_DATA_DIR = previous;
  rmSync(scratch, { recursive: true, force: true });
});
