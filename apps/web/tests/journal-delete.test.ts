import { afterAll, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
const originalDir = process.env.JOURNAL_DATA_DIR;
const scratch = mkdtempSync(join(tmpdir(), "journal-delete-"));
process.env.JOURNAL_DATA_DIR = scratch;

const { db, attachments, journalDays } = await import("../src/db");
const { DELETE, GET } = await import("../src/app/api/journal/[date]/route");

afterAll(() => {
  db.$client.close();
  if (originalDir === undefined) delete process.env.JOURNAL_DATA_DIR;
  else process.env.JOURNAL_DATA_DIR = originalDir;
  rmSync(scratch, { recursive: true, force: true });
});

const params = (date: string) => ({ params: Promise.resolve({ date }) });
const file = (id: string, ownerType: string, ownerId: string) => ({
  id,
  ownerType,
  ownerId,
  name: `${id}.png`,
  mime: "image/png",
  size: 1,
  data: Buffer.from([1]),
  createdAt: "2026-11-01T00:00:00.000Z",
});

it("deletes one day's note and its attachments, and nothing else", async () => {
  db.insert(journalDays)
    .values([
      { date: "2026-11-02", note: "Delete me", updatedAt: "x" },
      { date: "2026-11-03", note: "Keep me", updatedAt: "x" },
    ])
    .run();
  db.insert(attachments)
    .values([
      file("day_deleted", "day", "2026-11-02"),
      file("day_kept", "day", "2026-11-03"),
      file("trade_kept", "trade", "2026-11-02"),
    ])
    .run();

  const res = await DELETE(
    new Request("http://localhost/api/journal/2026-11-02", { method: "DELETE" }),
    params("2026-11-02"),
  );
  expect(res.status).toBe(200);

  expect(db.select({ date: journalDays.date }).from(journalDays).all()).toEqual([
    { date: "2026-11-03" },
  ]);
  expect(
    db
      .select({ id: attachments.id })
      .from(attachments)
      .all()
      .map((a) => a.id)
      .sort(),
  ).toEqual(["day_kept", "trade_kept"]);

  const day = await GET(
    new Request("http://localhost/api/journal/2026-11-02"),
    params("2026-11-02"),
  );
  expect(((await day.json()) as { note: string }).note).toBe("");
});

it("rejects a malformed date", async () => {
  const res = await DELETE(
    new Request("http://localhost/api/journal/x", { method: "DELETE" }),
    params("../x"),
  );
  expect(res.status).toBe(400);
});
