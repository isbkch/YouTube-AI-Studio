import type { DatabaseSync } from "node:sqlite";
import { id, StudioError } from "../../../shared/src/index.ts";
import type { Channel } from "./model.ts";

/** Table DDL only; the top-level library migration owns versioning and transactions. */
export function createAnalyticsTables(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS analytics_channels (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS analytics_records (channel_id TEXT NOT NULL REFERENCES analytics_channels(id) ON DELETE CASCADE, kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(channel_id,kind,id));
    CREATE TABLE IF NOT EXISTS analytics_locks (channel_id TEXT PRIMARY KEY, pid INTEGER NOT NULL, token TEXT NOT NULL);`);
}
export class AnalyticsStore {
  constructor(readonly db: DatabaseSync) {}
  channels(): Channel[] {
    return (
      this.db
        .prepare("SELECT data FROM analytics_channels ORDER BY rowid")
        .all() as { data: string }[]
    ).map((r) => JSON.parse(r.data));
  }
  channel(id: string): Channel {
    const row = this.db
      .prepare("SELECT data FROM analytics_channels WHERE id=?")
      .get(id) as { data: string } | undefined;
    if (!row) throw new StudioError("INVALID_INPUT", "Select a channel first.");
    return JSON.parse(row.data);
  }
  saveChannel(channel: Channel) {
    this.db
      .prepare(
        "INSERT INTO analytics_channels VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(channel.id, JSON.stringify(channel));
  }
  list<T>(channel: string, kind: string): T[] {
    return (
      this.db
        .prepare(
          "SELECT data FROM analytics_records WHERE channel_id=? AND kind=? ORDER BY rowid",
        )
        .all(channel, kind) as { data: string }[]
    ).map((r) => JSON.parse(r.data));
  }
  get<T>(channel: string, kind: string, id: string): T | undefined {
    const r = this.db
      .prepare(
        "SELECT data FROM analytics_records WHERE channel_id=? AND kind=? AND id=?",
      )
      .get(channel, kind, id) as { data: string } | undefined;
    return r ? JSON.parse(r.data) : undefined;
  }
  put(channel: string, kind: string, id: string, data: unknown) {
    this.db
      .prepare(
        "INSERT INTO analytics_records VALUES (?,?,?,?) ON CONFLICT(channel_id,kind,id) DO UPDATE SET data=excluded.data",
      )
      .run(channel, kind, id, JSON.stringify(data));
  }
  remove(channel: string, kind: string, id?: string) {
    if (id)
      this.db
        .prepare(
          "DELETE FROM analytics_records WHERE channel_id=? AND kind=? AND id=?",
        )
        .run(channel, kind, id);
    else
      this.db
        .prepare("DELETE FROM analytics_records WHERE channel_id=? AND kind=?")
        .run(channel, kind);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  acquire(channel: string): () => void {
    const token = id("analytics-lock");
    this.transaction(() => {
      const old = this.db
        .prepare("SELECT pid FROM analytics_locks WHERE channel_id=?")
        .get(channel) as { pid: number } | undefined;
      if (old) {
        let alive = true;
        try {
          process.kill(old.pid, 0);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ESRCH") alive = false;
        }
        if (alive)
          throw new StudioError(
            "CONFLICT",
            "A channel operation is already running.",
            "Wait or cancel it before trying again.",
          );
        this.db
          .prepare("DELETE FROM analytics_locks WHERE channel_id=?")
          .run(channel);
        if (this.channels().some((c) => c.id === channel))
          this.put(channel, "recovery", id("recovery"), {
            at: new Date().toISOString(),
            message: "Interrupted operation recovered; retry to refresh.",
          });
      }
      this.db
        .prepare("INSERT INTO analytics_locks VALUES(?,?,?)")
        .run(channel, process.pid, token);
    });
    return () => {
      this.db
        .prepare("DELETE FROM analytics_locks WHERE channel_id=? AND token=?")
        .run(channel, token);
    };
  }
}
