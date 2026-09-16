import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import { applyPatch, patchSchema, validatePlan, validateSources, operationSchema, type PlanPatch, type ProductionPlan } from '../../production-plan/src/index.ts';
import { DirectorAgent, MockAIProvider, validateTranscript, type AIProvider } from '../../agents/src/index.ts';
import { hash, id, now, safePath, StudioError, type CreatorProfile } from '../../shared/src/index.ts';
import { importRecording, extractAudio } from '../../media/src/index.ts';
import { Store } from './store.ts';
import { transition, type Project, type Job } from './model.ts';
import { buildProject } from './build.ts';
import { JobGraph } from './jobs.ts';

export class Studio {
 constructor(public store:Store,public provider:AIProvider=new MockAIProvider(),private notify?:(event:unknown)=>void){}
 snapshot(projectId:string){const p=this.store.get(projectId);return {...p,directory:this.store.dir(p),jobs:this.store.jobs(p.id),assets:this.store.assets(p.id),events:this.store.events(p.id)};}
 private async locked<T>(projectId:string,fn:(p:Project)=>Promise<T>|T){const p=this.store.get(projectId);const release=this.store.acquire(p.id);try{return await fn(p);}finally{release();}}
 private async operation(p:Project,type:string,label:string,fn:(signal:AbortSignal)=>Promise<void>,signal?:AbortSignal){const graph=new JobGraph([{id:id(type),type,label,dependencies:[],maxRetries:0,run:ctx=>fn(ctx.signal)}],p.id,job=>{this.store.job(job);this.notify?.({event:'job',job});});await graph.run(signal);}
 async saveScript(projectId:string,text:string){return this.locked(projectId,async p=>{
  if(!text.trim()||text.length>250000)throw new StudioError('INVALID_INPUT','Script must contain 1–250,000 characters.');
  if(!['IDEA','SCRIPTING','AWAITING_SCRIPT_APPROVAL','READY_TO_RECORD'].includes(p.status))throw new StudioError('CONFLICT','The approved script is locked after media import.','Create a new project for a new script; scene-level changes belong in revisions.');
  const script={version:p.scripts.length+1,text,createdAt:now()};await this.store.artifact(p,`scripts/script-v${script.version}.json`,script);
  return this.store.update(p.id,x=>{if(x.status!=='SCRIPTING')x.status=transition(x.status,'SCRIPTING');x.scripts.push(script);x.scriptApproval=null;x.status=transition(x.status,'AWAITING_SCRIPT_APPROVAL');});
 });}
 async approveScript(projectId:string,version:number){return this.locked(projectId,p=>{const script=p.scripts.at(-1);if(!script||script.version!==version)throw new StudioError('CONFLICT','Script version changed. Review the current script.');return this.store.update(p.id,x=>{x.status=transition(x.status,'READY_TO_RECORD');x.scriptApproval={version,hash:hash(script),approvedAt:now(),approvedBy:'creator'};this.store.event(x.id,{event:'script.approved',version});});});}
 async importMedia(projectId:string,file:string,signal?:AbortSignal){return this.locked(projectId,async p=>{
  if(p.status!=='READY_TO_RECORD'||!p.scriptApproval)throw new StudioError('CONFLICT','Approve the script before importing A-roll.');
  await this.operation(p,'import','Inspect and import A-roll',async signal=>{const r=await importRecording(this.store.dir(p),file,signal);this.store.update(p.id,x=>{x.recordings.push(r);x.status=transition(x.status,'MEDIA_IMPORTED');});},signal);return this.snapshot(p.id);
 });}
 async loadTranscript(projectId:string,input:unknown){return this.locked(projectId,async p=>{
  if(p.status!=='MEDIA_IMPORTED')throw new StudioError('CONFLICT','Load the transcript after importing media and before planning.');
  const r=p.recordings.at(-1)!;const raw=z.object({segments:z.array(z.unknown())}).passthrough().parse(input);
  const transcript=validateTranscript({...raw,recordingId:r.id},r);await this.store.artifact(p,`transcripts/transcript-${hash(transcript).slice(0,16)}.json`,transcript);return this.store.update(p.id,x=>{x.transcripts.push(transcript);});
 });}
 async transcribe(projectId:string,signal?:AbortSignal){return this.locked(projectId,async p=>{
  if(p.status!=='MEDIA_IMPORTED')throw new StudioError('CONFLICT','Transcribe after media import.');const r=p.recordings.at(-1)!;
  this.store.update(p.id,x=>{x.status=transition(x.status,'TRANSCRIBING');});
  try {await this.operation(p,'transcription','Extract and transcribe A-roll',async signal=>{
   const audio=await safePath(this.store.dir(p),`cache/transcription-${r.hash}.mp3`);await extractAudio(await safePath(this.store.dir(p),r.path),audio,signal);
   const result=await this.provider.transcribe({file:audio,recording:r,signal,fixture:p.transcripts.at(-1)});
   await this.store.artifact(p,`transcripts/transcript-${hash(result.output).slice(0,16)}.json`,result.output);this.store.update(p.id,x=>{x.transcripts.push(result.output);x.usage.push(result.usage);});
  },signal);}finally{this.store.update(p.id,x=>{x.status=transition(x.status,'MEDIA_IMPORTED');});}
  return this.snapshot(p.id);
 });}
 async generatePlan(projectId:string,signal?:AbortSignal){return this.locked(projectId,async p=>{
  if(!['MEDIA_IMPORTED','AWAITING_STORYBOARD_APPROVAL'].includes(p.status)||!p.transcripts.length||!p.scriptApproval)throw new StudioError('CONFLICT','Planning requires an approved script, recording and transcript.');
  this.store.update(p.id,x=>{x.status=transition(x.status,'PLANNING');x.planApproval=null;x.roughCutApproval=null;});
  try{await this.operation(p,'director','Director • production plan',async signal=>{
    const result=await new DirectorAgent(this.provider).plan({projectId:p.id,script:p.scripts.at(-1)!,transcript:p.transcripts.at(-1)!,recording:p.recordings.at(-1)!,creator:p.creator,version:p.plans.length+1},signal);
    await this.store.artifact(p,`production-plans/plan-v${result.output.version}.json`,result.output);this.store.update(p.id,x=>{x.plans.push(result.output);x.usage.push(result.usage);x.status=transition(x.status,'AWAITING_STORYBOARD_APPROVAL');});this.store.event(p.id,{event:'director.planned',model:result.usage.model,summary:result.output.director.summary});
  },signal);}catch(e){this.store.update(p.id,x=>{if(x.status==='PLANNING')x.status=transition(x.status,'MEDIA_IMPORTED');});throw e;}return this.snapshot(p.id);
 });}
 async approvePlan(projectId:string,version:number){return this.locked(projectId,p=>{
  const plan=validatePlan(p.plans.at(-1));if(plan.version!==version||p.status!=='AWAITING_STORYBOARD_APPROVAL')throw new StudioError('CONFLICT','Review the current storyboard version.');
  return this.store.update(p.id,x=>{x.planApproval={version,hash:hash(plan),approvedAt:now(),approvedBy:'creator'};this.store.event(x.id,{event:'storyboard.approved',version});});
 });}
 async build(projectId:string,signal?:AbortSignal){return buildProject(this.store,projectId,signal,job=>this.notify?.({event:'job',job}));}
 async propose(projectId:string,request:string,sceneId:string,signal?:AbortSignal){return this.locked(projectId,async p=>{
  this.revisionAllowed(p);if(!request.trim()||request.length>10000)throw new StudioError('INVALID_INPUT','Describe the requested change in 1–10,000 characters.');
  let patch:PlanPatch|undefined;await this.operation(p,'director-revision','Director • revision proposal',async signal=>{const result=await new DirectorAgent(this.provider).revise(p.plans.at(-1)!,request,sceneId,signal);patch=this.validateProposal(p,result.output);this.store.update(p.id,x=>{x.revisions.push({patch:patch!,status:'PROPOSED',decidedAt:null});x.usage.push(result.usage);});},signal);return patch;
 });}
 async proposeOperations(projectId:string,operations:unknown,request:string){return this.locked(projectId,p=>{
  this.revisionAllowed(p);const ops=z.array(operationSchema).min(1).parse(operations);const current=p.plans.at(-1)!;const patch=this.validateProposal(p,{id:id('patch'),createdAt:now(),originatingRequest:request,rationale:'Explicit creator edit; only the listed scene instructions will change.',affectedScenes:[...new Set(ops.flatMap(o=>o.type==='mergeScenes'?[o.sceneId,o.nextSceneId]:[o.sceneId]))],previousVersion:current.version,resultingVersion:current.version+1,operations:ops});this.store.update(p.id,x=>{x.revisions.push({patch,status:'PROPOSED',decidedAt:null});});return patch;
 });}
 private revisionAllowed(p:Project){if(!['AWAITING_STORYBOARD_APPROVAL','AWAITING_ROUGH_CUT_APPROVAL','READY_TO_RENDER','AWAITING_PUBLISH_APPROVAL'].includes(p.status)||!p.plans.length)throw new StudioError('CONFLICT','Revisions are available after planning and when production is idle.');}
 private validateProposal(p:Project,input:unknown){const patch=patchSchema.parse(input);const next=applyPatch(p.plans.at(-1)!,patch);validateSources(next,p.recordings,p.transcripts.at(-1)!.segments.map(s=>s.id));return patch;}
 async decidePatch(projectId:string,patchId:string,apply:boolean){return this.locked(projectId,async p=>{
  this.revisionAllowed(p);const proposal=p.revisions.find(r=>r.patch.id===patchId);if(!proposal||proposal.status!=='PROPOSED')throw new StudioError('CONFLICT','Proposal is no longer pending.');
  let next:ProductionPlan|undefined;if(apply){this.validateProposal(p,proposal.patch);next=applyPatch(p.plans.at(-1)!,proposal.patch);await this.store.artifact(p,`production-plans/plan-v${next.version}.json`,next);await this.store.artifact(p,`production-plans/${proposal.patch.id}.json`,proposal.patch);}
  return this.store.update(p.id,x=>{const r=x.revisions.find(r=>r.patch.id===patchId)!;r.status=apply?'APPLIED':'REJECTED';r.decidedAt=now();if(next){x.status=transition(x.status,'REVISING');x.plans.push(next);x.planApproval=null;x.roughCutApproval=null;x.finalRender=null;x.publishApproval=null;x.status=transition(x.status,'AWAITING_STORYBOARD_APPROVAL');}this.store.event(p.id,{event:apply?'patch.applied':'patch.rejected',patchId});});
 });}
 async undo(projectId:string){return this.locked(projectId,async p=>{
  this.revisionAllowed(p);if(p.plans.length<2)throw new StudioError('CONFLICT','There is no earlier production plan.');const previous=p.plans.at(-2)!;const next={...structuredClone(previous),version:p.plans.at(-1)!.version+1,createdAt:now()};await this.store.artifact(p,`production-plans/plan-v${next.version}.json`,next);
  return this.store.update(p.id,x=>{x.status=transition(x.status,'REVISING');x.plans.push(next);x.planApproval=null;x.roughCutApproval=null;x.finalRender=null;x.publishApproval=null;x.status=transition(x.status,'AWAITING_STORYBOARD_APPROVAL');this.store.event(p.id,{event:'plan.undo',restoredVersion:previous.version,newVersion:next.version});});
 });}
 async approveRoughCut(projectId:string,version:number){return this.locked(projectId,p=>{
  const plan=p.plans.at(-1)!;if(plan.version!==version||!p.builds.some(b=>b.planVersion===version))throw new StudioError('CONFLICT','Review the current completed rough cut first.');
  return this.store.update(p.id,x=>{x.status=transition(x.status,'READY_TO_RENDER');x.roughCutApproval={version,hash:hash(plan),approvedAt:now(),approvedBy:'creator'};this.store.event(p.id,{event:'roughCut.approved',version});});
 });}
 addPreference(text:string){if(!text.trim()||text.length>1000)throw new StudioError('INVALID_INPUT','Preference must be between 1 and 1,000 characters.');const p=this.store.creator();p.preferences.push({id:id('preference'),text,source:'explicit',createdAt:now()});this.store.setCreator(p);return p;}
 setCreator(profile:CreatorProfile){const parsed=z.strictObject({name:z.string().min(1).max(100),channel:z.string().min(1).max(100),format:z.string().max(300),targetMinutes:z.tuple([z.number().positive(),z.number().positive()]),subjects:z.array(z.string().max(100)),brand:z.strictObject({background:z.string().regex(/^#[a-fA-F0-9]{6}$/),foreground:z.string().regex(/^#[a-fA-F0-9]{6}$/),accent:z.string().regex(/^#[a-fA-F0-9]{6}$/),fontFamily:z.string().min(1).max(100)}),preferences:z.array(z.strictObject({id:z.string(),text:z.string().max(1000),source:z.literal('explicit'),createdAt:z.iso.datetime()}))}).parse(profile);this.store.setCreator(parsed);return parsed;}
}
export async function readJSONFile(file:string){if((await stat(file)).size>10_000_000)throw new StudioError('INVALID_INPUT','JSON input exceeds 10 MB.');return JSON.parse(await readFile(file,'utf8')) as unknown;}
export type ProjectSnapshot=ReturnType<Studio['snapshot']>;
export type JobUpdate={event:'job';job:Job};
