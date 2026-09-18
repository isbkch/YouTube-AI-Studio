import type { DatabaseSync } from "node:sqlite";
import { StudioError } from "../../shared/src/index.ts";
import { createAnalyticsTables } from "./analytics/store.ts";

/** The library store owns the database-wide version, including all domain tables. */
export function migrateLibrary(db: DatabaseSync) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const version = (
      db.prepare("PRAGMA user_version").get() as { user_version: number }
    ).user_version;
    if (version > 2)
      throw new StudioError(
        "CONFIGURATION",
        "This library was created by a newer runtime.",
      );
    if (version < 1)
      db.exec(`
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS locks (project_id TEXT PRIMARY KEY, pid INTEGER NOT NULL, token TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, project_id TEXT, created_at TEXT NOT NULL, data TEXT NOT NULL);
    `);
    if (version < 2) createAnalyticsTables(db);
    db.exec("PRAGMA user_version=2; COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
