import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrateLibrary } from "../packages/orchestrator/src/migrations.ts";

test("free library migration creates production tables and preserves legacy data", () => {
  const db = new DatabaseSync(":memory:");
  try {
    migrateLibrary(db);
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((r) => r.name);
    assert.deepEqual(tables, [
      "assets",
      "events",
      "jobs",
      "locks",
      "projects",
      "settings",
    ]);
    db.exec(
      "CREATE TABLE legacy_records (value TEXT); INSERT INTO legacy_records VALUES ('preserved'); PRAGMA user_version=1;",
    );
    migrateLibrary(db);
    assert.equal(
      db.prepare("SELECT value FROM legacy_records").get()?.value,
      "preserved",
    );
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 2);
    migrateLibrary(db);
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM legacy_records").get()?.n,
      1,
    );
  } finally {
    db.close();
  }
});
