import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { ffmpeg } from '../../media/src/index.ts';
import { StudioError, inside } from '../../shared/src/index.ts';
import type { ProductionPlan } from '../../production-plan/src/index.ts';
import type { Asset, Recording } from './model.ts';
const clipSchema=z.strictObject({id:z.string(),sceneId:z.string(),assetId:z.string(),path:z.string(),startFrame:z.number().int().nonnegative(),sourceInFrame:z.number().int().nonnegative(),durationFrames:z.number().int().positive(),sourceDurationFrames:z.number().int().positive(),punchIn:z.number().min(1).max(1.35),gainDb:z.number().min(-24).max(12)});
export const timelineSchema=z.strictObject({schemaVersion:z.literal('1.0.0'),name:z.string(),planVersion:z.number().int().positive(),frameRate:z.number().int().positive(),resolution:z.strictObject({width:z.number().int().positive(),height:z.number().int().positive()}),durationFrames:z.number().int().positive(),tracks:z.array(z.strictObject({id:z.string(),kind:z.enum(['video','audio']),name:z.string(),clips:z.array(clipSchema)})),markers:z.array(z.strictObject({frame:z.number().int().nonnegative(),durationFrames:z.number().int().positive(),label:z.string(),sceneId:z.string()}))});
export type Timeline=z.infer<typeof timelineSchema>;
export function validateTimeline(input:unknown):Timeline {
 const t=timelineSchema.parse(input);const ids=new Set<string>();
 for(const track of t.tracks){let end=0;for(const c of track.clips){if(ids.has(c.id)||c.startFrame<end||c.startFrame+c.durationFrames>t.durationFrames||c.sourceInFrame+c.durationFrames>c.sourceDurationFrames+1)throw new StudioError('INVALID_PLAN',`Invalid timeline clip ${c.id}.`);inside('/project',c.path);ids.add(c.id);end=c.startFrame+c.durationFrames;}}
 return t;
}
export function makeTimeline(plan:ProductionPlan,recordings:Recording[],graphics:Map<string,Asset>):Timeline {
 const video:Timeline['tracks'][number]={id:'v1',kind:'video',name:'Presenter • source proxy',clips:[]};
 const overlays:Timeline['tracks'][number]={id:'v2',kind:'video',name:'WinTheCloud graphics',clips:[]};
 const audio:Timeline['tracks'][number]={id:'a1',kind:'audio',name:'A-roll narration',clips:[]};
 for(const s of plan.scenes){const r=recordings.find(r=>r.id===s.camera.recordingId);if(!r?.proxyPath)throw new StudioError('INVALID_PLAN','Timeline needs a conformed proxy.');const c={id:`${s.id}-video`,sceneId:s.id,assetId:r.id,path:r.proxyPath,startFrame:s.startFrame,sourceInFrame:s.sourceInFrame,durationFrames:s.durationFrames,sourceDurationFrames:Math.floor(r.duration*plan.frameRate),punchIn:s.camera.punchIn,gainDb:s.audio.gainDb};video.clips.push(c);if(r.hasAudio)audio.clips.push({...c,id:`${s.id}-audio`,punchIn:1});
  const a=graphics.get(s.id);if(s.enabled&&s.visual.graphic){if(!a)throw new StudioError('INVALID_PLAN',`Missing graphic for ${s.id}`);overlays.clips.push({...c,id:`${s.id}-graphic`,assetId:a.assetId,path:a.path,sourceInFrame:0,sourceDurationFrames:s.durationFrames,punchIn:1});}}
 return validateTimeline({schemaVersion:'1.0.0',name:'WinTheCloud rough cut',planVersion:plan.version,frameRate:plan.frameRate,resolution:plan.resolution,durationFrames:plan.durationFrames,tracks:[video,overlays,audio],markers:plan.scenes.map(s=>({frame:s.startFrame,durationFrames:s.durationFrames,label:s.visual.description,sceneId:s.id}))});
}
const time=(value:number,rate:number)=>({OTIO_SCHEMA:'RationalTime.1',value,rate});
const range=(start:number,duration:number,rate:number)=>({OTIO_SCHEMA:'TimeRange.1',start_time:time(start,rate),duration:time(duration,rate)});
/** OTIO uses seconds-equivalent rational frame times and file URLs; no application-specific commands. */
export function toOTIO(t:Timeline,projectDir:string) {
 validateTimeline(t);return {OTIO_SCHEMA:'Timeline.1',name:t.name,metadata:{wts:{planVersion:t.planVersion,resolution:t.resolution,framingNote:'Camera punch-in and gain are encoded in the companion FCPXML; OTIO metadata retains these instructions.'}},global_start_time:time(0,t.frameRate),tracks:{OTIO_SCHEMA:'Stack.1',name:'Production',metadata:{},effects:[],markers:t.markers.map(m=>({OTIO_SCHEMA:'Marker.2',name:m.label,color:'GREEN',marked_range:range(m.frame,m.durationFrames,t.frameRate),metadata:{sceneId:m.sceneId}})),children:t.tracks.map(track=>{
  const children:unknown[]=[];let cursor=0;for(const c of track.clips){if(c.startFrame>cursor)children.push({OTIO_SCHEMA:'Gap.1',name:'',metadata:{},effects:[],markers:[],source_range:range(0,c.startFrame-cursor,t.frameRate)});
   children.push({OTIO_SCHEMA:'Clip.2',name:c.sceneId,metadata:{wts:{assetId:c.assetId,punchIn:c.punchIn,gainDb:c.gainDb}},source_range:range(c.sourceInFrame,c.durationFrames,t.frameRate),effects:[],markers:[],media_references:{DEFAULT_MEDIA:{OTIO_SCHEMA:'ExternalReference.1',target_url:pathToFileURL(inside(projectDir,c.path)).href,name:path.basename(c.path),metadata:{},available_range:range(0,c.sourceDurationFrames,t.frameRate)}},active_media_reference_key:'DEFAULT_MEDIA'});cursor=c.startFrame+c.durationFrames;}
  if(cursor<t.durationFrames)children.push({OTIO_SCHEMA:'Gap.1',name:'',metadata:{},effects:[],markers:[],source_range:range(0,t.durationFrames-cursor,t.frameRate)});
  return {OTIO_SCHEMA:'Track.1',name:track.name,kind:track.kind==='video'?'Video':'Audio',metadata:{},source_range:null,effects:[],markers:[],children};})}};
}
const xml=(s:string)=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
export function toFCPXML(t:Timeline,projectDir:string) {
 validateTimeline(t);const fps=t.frameRate;const seconds=(n:number)=>`${n}/${fps}s`;const base=t.tracks.find(x=>x.id==='v1')!;const overlays=t.tracks.find(x=>x.id==='v2')!;const audio=t.tracks.find(x=>x.id==='a1')!;const resources=new Map<string,{id:string;duration:number;audio:boolean}>();
 for(const track of t.tracks)for(const c of track.clips){const old=resources.get(c.path);resources.set(c.path,{id:old?.id||`r${resources.size+2}`,duration:Math.max(old?.duration||0,c.sourceDurationFrames),audio:!!old?.audio||track.kind==='audio'});}
 const assets=[...resources].map(([file,r])=>`<asset id="${r.id}" name="${xml(path.basename(file))}" start="0s" duration="${seconds(r.duration)}" hasVideo="1" format="r1"${r.audio?' hasAudio="1" audioSources="1" audioChannels="2" audioRate="48000"':''}><media-rep kind="original-media" src="${xml(pathToFileURL(inside(projectDir,file)).href)}"/></asset>`).join('\n');
 const clips=base.clips.map(c=>{const g=overlays.clips.find(g=>g.sceneId===c.sceneId);const hasAudio=audio.clips.some(a=>a.sceneId===c.sceneId);return `<asset-clip name="${xml(c.sceneId)}" ref="${resources.get(c.path)!.id}" offset="${seconds(c.startFrame)}" start="${seconds(c.sourceInFrame)}" duration="${seconds(c.durationFrames)}"${hasAudio?' audioRole="dialogue"':' srcEnable="video"'}><adjust-transform position="0 0" scale="${c.punchIn} ${c.punchIn}" anchor="0 0"/>${hasAudio?`<adjust-volume amount="${c.gainDb}dB"/>`:''}${g?`<asset-clip lane="1" name="${xml(g.sceneId+' graphic')}" ref="${resources.get(g.path)!.id}" offset="${seconds(c.sourceInFrame)}" start="0s" duration="${seconds(g.durationFrames)}" srcEnable="video"/>`:''}<marker start="${seconds(c.sourceInFrame)}" duration="${seconds(1)}" value="${xml(t.markers.find(m=>m.sceneId===c.sceneId)?.label||c.sceneId)}"/></asset-clip>`;}).join('\n');
 return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n<fcpxml version="1.8"><resources><format id="r1" name="WinTheCloud${t.resolution.height}p${fps}" frameDuration="1/${fps}s" width="${t.resolution.width}" height="${t.resolution.height}" colorSpace="1-1-1 (Rec. 709)"/>${assets}</resources><library><event name="WinTheCloud Studio"><project name="${xml(t.name+' v'+t.planVersion)}"><sequence format="r1" duration="${seconds(t.durationFrames)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k"><spine>${clips}</spine></sequence></project></event></library></fcpxml>\n`;
}
export async function renderSegment(options:{source:string;graphic:string|null;sourceStart:number;duration:number;punchIn:number;gainDb:number;hasAudio:boolean;output:string;signal?:AbortSignal;progress?:(f:number)=>void}) {
 const o=options;const inputs=['-ss',String(o.sourceStart),'-protocol_whitelist','file,pipe','-i',o.source];if(o.graphic)inputs.push('-protocol_whitelist','file,pipe','-i',o.graphic);
 const visualIndex=o.graphic?1:0;const filters=`scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,setsar=1${!o.graphic&&o.punchIn!==1?`,scale=ceil(iw*${o.punchIn}/2)*2:ceil(ih*${o.punchIn}/2)*2,crop=1280:720`:''},fps=30`;
 if(!o.hasAudio)inputs.push('-f','lavfi','-i','anullsrc=r=48000:cl=stereo');
 const audioIndex=o.hasAudio?0:o.graphic?2:1;
 await ffmpeg([...inputs,'-map',`${visualIndex}:v:0`,'-map',`${audioIndex}:a:0`,'-t',String(o.duration),'-vf',filters,'-af',`volume=${o.gainDb}dB,apad`,'-c:v','libx264','-preset','veryfast','-crf','24','-pix_fmt','yuv420p','-c:a','aac','-b:a','160k','-ar','48000','-ac','2','-video_track_timescale','15360','-movflags','+faststart',o.output],o.signal,o.progress,o.duration);
}
export async function concatenateSegments(projectDir:string,segments:string[],output:string,signal?:AbortSignal) {
 // Concat entries are trusted managed filenames, never model or user command text.
 const list=output+'.concat.txt';
 await writeFile(list,segments.map(file=>`file '${inside(projectDir,file).replace(/'/g,"'\\''")}'`).join('\n')+'\n');
 await ffmpeg(['-f','concat','-safe','0','-protocol_whitelist','file,pipe','-i',list,'-c','copy','-movflags','+faststart',output],signal);
}
