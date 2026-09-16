import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, renameSync, existsSync, lstatSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { atomicJSON, defaultCreator, id, inside, now, slugify, StudioError } from '../../shared/src/index.ts';
import type { CreatorProfile } from '../../shared/src/index.ts';
import type { Asset, Job, Project } from './model.ts';
export const defaultRoot = () => process.env.WTS_HOME || path.join(os.homedir(), 'Movies', 'WinTheCloud Studio');
const folders = ['research','scripts','recordings','transcripts','production-plans','assets/generated','renders','cache','logs'];
export class Store {
  readonly db: DatabaseSync;
  constructor(public root = defaultRoot()) {
    this.root = path.resolve(root); mkdirSync(path.join(this.root, 'projects'), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(this.root, 'studio.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS locks (project_id TEXT PRIMARY KEY, pid INTEGER NOT NULL, token TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, project_id TEXT, created_at TEXT NOT NULL, data TEXT NOT NULL);
      PRAGMA user_version=1;`);
  }
  close() { this.db.close(); }
  list(): Project[] { return (this.db.prepare('SELECT data FROM projects ORDER BY rowid DESC').all() as {data:string}[]).map(r => JSON.parse(r.data)); }
  get(projectId: string): Project {
    const row = this.db.prepare('SELECT data FROM projects WHERE id=? OR slug=?').get(projectId,projectId) as {data:string}|undefined;
    if (!row) throw new StudioError('INVALID_INPUT', `Project ${projectId} does not exist.`);
    return JSON.parse(row.data);
  }
  dir(project: Project) {
    const base = inside(path.join(this.root, 'projects'), project.slug);
    if (existsSync(base) && lstatSync(base).isSymbolicLink()) throw new StudioError('INVALID_INPUT', 'Project directory cannot be a symlink.');
    return base;
  }
  create(title: string, description = '', targetDuration = 900): Project {
    if (!title.trim() || title.length > 200 || !Number.isFinite(targetDuration) || targetDuration < 1 || targetDuration > 10800) throw new StudioError('INVALID_INPUT', 'Provide a title and target duration between 1 second and 3 hours.');
    const projectId = id('project');
    const p: Project = { schemaVersion: '1.0.0', id: projectId, title: title.trim(), slug: `${slugify(title)}-${projectId.slice(-8)}`, description, targetDuration, status: 'IDEA', createdAt: now(), updatedAt: now(), creator: this.creator(), research: { notes: '', sources: [] }, outline: [], scripts: [], scriptApproval: null, recordings: [], transcripts: [], plans: [], planApproval: null, roughCutApproval: null, revisions: [], builds: [], finalRender: null, publication: null, publishApproval: null, usage: [] };
    const dir = this.dir(p); mkdirSync(dir, { recursive:true, mode:0o700 });
    for (const folder of folders) mkdirSync(inside(dir, folder), { recursive:true });
    this.db.prepare('INSERT INTO projects VALUES (?,?,?)').run(p.id,p.slug,JSON.stringify(p)); this.snapshot(p); this.event(p.id, { event:'project.created' }); return p;
  }
  update(projectId: string, change: (p: Project) => void): Project {
    this.db.exec('BEGIN IMMEDIATE'); let p: Project;
    try { p = this.get(projectId); change(p); p.updatedAt = now(); this.db.prepare('UPDATE projects SET data=? WHERE id=?').run(JSON.stringify(p),p.id); this.db.exec('COMMIT'); }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
    this.snapshot(p); return p;
  }
  private snapshot(p: Project) { const dir = this.dir(p); const temp = path.join(dir, `project.${id('tmp')}.json`); writeFileSync(temp,JSON.stringify(p,null,2)+'\n',{mode:0o600}); renameSync(temp,path.join(dir,'project.json')); }
  event(projectId: string, data: unknown) { this.db.prepare('INSERT INTO events(project_id,created_at,data) VALUES(?,?,?)').run(projectId,now(),JSON.stringify(data)); }
  events(projectId: string) { return this.db.prepare('SELECT created_at, data FROM events WHERE project_id=? ORDER BY id DESC LIMIT 100').all(projectId); }
  job(job: Job) { this.db.prepare('INSERT INTO jobs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(job.id,job.projectId,JSON.stringify(job)); }
  jobs(projectId: string): Job[] { return (this.db.prepare('SELECT data FROM jobs WHERE project_id=? ORDER BY rowid DESC').all(projectId) as {data:string}[]).map(r=>JSON.parse(r.data)); }
  asset(projectId: string, asset: Asset) { this.db.prepare('INSERT INTO assets VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(asset.assetId,projectId,JSON.stringify(asset)); }
  assets(projectId: string): Asset[] { return (this.db.prepare('SELECT data FROM assets WHERE project_id=?').all(projectId) as {data:string}[]).map(r=>JSON.parse(r.data)); }
  creator(): CreatorProfile { const row = this.db.prepare("SELECT data FROM settings WHERE key='creator'").get() as {data:string}|undefined; return row ? JSON.parse(row.data) : structuredClone(defaultCreator); }
  setCreator(profile: CreatorProfile) { this.db.prepare("INSERT INTO settings VALUES('creator',?) ON CONFLICT(key) DO UPDATE SET data=excluded.data").run(JSON.stringify(profile)); }
  acquire(projectId: string): () => void {
    const token = id('lock'); this.db.exec('BEGIN IMMEDIATE');
    try {
      const lock = this.db.prepare('SELECT pid FROM locks WHERE project_id=?').get(projectId) as {pid:number}|undefined;
      if (lock) { let alive = true; try { process.kill(lock.pid,0); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
        if (alive) throw new StudioError('CONFLICT','This project already has an active operation.','Wait for it to finish or cancel it.');
        this.db.prepare('DELETE FROM locks WHERE project_id=?').run(projectId);
        for (const job of this.jobs(projectId).filter(j => ['RUNNING','QUEUED','BLOCKED'].includes(j.status))) this.job({ ...job, status:'FAILED', completedAt:now(), error:{ kind:'EXTERNAL_TOOL', message:'Runtime stopped before completion.', recovery:'Retry the operation; verified cached outputs will be reused.', retryable:true } });
      }
      this.db.prepare('INSERT INTO locks VALUES(?,?,?)').run(projectId,process.pid,token); this.db.exec('COMMIT');
    } catch(e) { this.db.exec('ROLLBACK'); throw e; }
    return () => { this.db.prepare('DELETE FROM locks WHERE project_id=? AND token=?').run(projectId,token); };
  }
  async artifact(p: Project, relative: string, data: unknown) { await atomicJSON(inside(this.dir(p),relative),data); }
}
