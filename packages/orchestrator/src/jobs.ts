import { id, now, errorInfo, StudioError } from '../../shared/src/index.ts';
import type { Job } from './model.ts';
export interface TaskContext { signal:AbortSignal;progress:(fraction:number)=>void;log:(message:string)=>void;produced:(assetId:string)=>void;jobId:string; }
export interface Task { id:string;type:string;label:string;dependencies:string[];maxRetries?:number;run:(context:TaskContext)=>Promise<void>; }
export function validateGraph(tasks:Pick<Task,'id'|'dependencies'>[]) {
  const map=new Map(tasks.map(t=>[t.id,t]));if(map.size!==tasks.length)throw new StudioError('INVALID_INPUT','Duplicate job ID.');
  const visiting=new Set<string>(),done=new Set<string>();
  const visit=(jobId:string)=>{if(done.has(jobId))return;if(visiting.has(jobId))throw new StudioError('INVALID_INPUT',`Dependency cycle at ${jobId}.`);const task=map.get(jobId);if(!task)throw new StudioError('INVALID_INPUT',`Missing dependency ${jobId}.`);visiting.add(jobId);task.dependencies.forEach(visit);visiting.delete(jobId);done.add(jobId);};
  tasks.forEach(t=>visit(t.id));
}
export class JobGraph {
  readonly jobs:Job[];private controller=new AbortController();
  constructor(private tasks:Task[],projectId:string,private persist:(job:Job)=>void,private concurrency=2) {
    validateGraph(tasks);if(!Number.isInteger(concurrency)||concurrency<1||concurrency>4)throw new StudioError('INVALID_INPUT','Job concurrency must be between 1 and 4.');
    const runId=id('run');this.jobs=tasks.map(t=>({id:`${runId}-${t.id}`,projectId,runId,type:t.type,label:t.label,status:t.dependencies.length?'BLOCKED':'QUEUED',dependencies:t.dependencies.map(d=>`${runId}-${d}`),progress:0,logs:[],startedAt:null,completedAt:null,error:null,retryCount:0,producedAssets:[]}));this.jobs.forEach(j=>persist(j));
  }
  cancel(){this.controller.abort();}
  async run(externalSignal?:AbortSignal) {
    const abort=()=>this.cancel();externalSignal?.addEventListener('abort',abort,{once:true});if(externalSignal?.aborted)this.cancel();
    const running=new Map<number,Promise<void>>();
    const finish=(job:Job)=>{job.completedAt=now();this.persist(job);};
    const start=async(index:number)=>{
      const task=this.tasks[index],job=this.jobs[index];job.startedAt=now();job.status='RUNNING';this.persist(job);
      const log=(message:string)=>{job.logs.push(message);job.logs=job.logs.slice(-100);this.persist(job);};let lastProgress=0;
      for(;;){
        try {
          await task.run({signal:this.controller.signal,jobId:job.id,progress:f=>{if(!Number.isFinite(f))return;job.progress=Math.max(job.progress,Math.min(1,Math.max(0,f)));if(Date.now()-lastProgress>250){this.persist(job);lastProgress=Date.now();}},log,produced:assetId=>{if(!job.producedAssets.includes(assetId))job.producedAssets.push(assetId);}});
          this.controller.signal.throwIfAborted();job.status='COMPLETE';job.progress=1;job.error=null;break;
        }catch(e){job.error=errorInfo(e);if(this.controller.signal.aborted){job.status='CANCELLED';break;}
          if(job.error.retryable&&job.retryCount<(task.maxRetries??1)){job.retryCount++;log(`Retry ${job.retryCount}: ${job.error.message}`);continue;}
          job.status='FAILED';log(job.error.message);break;
        }
      }
      finish(job);
    };
    try {
      for(;;){
        for(let i=0;i<this.jobs.length;i++){
          const j=this.jobs[i];if(!['QUEUED','BLOCKED'].includes(j.status))continue;
          const deps=j.dependencies.map(d=>this.jobs.find(x=>x.id===d)!);
          if(this.controller.signal.aborted){j.status='CANCELLED';finish(j);continue;}
          if(deps.some(d=>d.status==='FAILED'||d.status==='CANCELLED')){j.status='BLOCKED';j.error={kind:'CONFLICT',message:'A required job did not complete.',recovery:'Retry the build after fixing the failed dependency. Completed assets will be reused.',retryable:true};this.persist(j);continue;}
          if(deps.every(d=>d.status==='COMPLETE')&&running.size<this.concurrency){j.status='QUEUED';const promise=start(i).finally(()=>running.delete(i));running.set(i,promise);}
        }
        if(!running.size)break;
        await Promise.race(running.values());
      }
    }finally{externalSignal?.removeEventListener('abort',abort);}
    const failed=this.jobs.find(j=>j.status==='FAILED');if(failed)throw new StudioError('EXTERNAL_TOOL',`${failed.label}: ${failed.error?.message}`,failed.error?.recovery,true);
    if(this.controller.signal.aborted)throw new StudioError('CANCELLED','Production cancelled.','Rebuild to reuse completed assets.',true);
    if(this.jobs.some(j=>j.status!=='COMPLETE'))throw new StudioError('CONFLICT','Production is blocked by an incomplete dependency.');
    return this.jobs;
  }
}
