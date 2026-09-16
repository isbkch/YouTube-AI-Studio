import { access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executable, runBinary } from '../../media/src/index.ts';
import { defaultRoot } from './store.ts';
import { resolveApp } from '../../resolve-engine/src/index.ts';
export interface Check {name:string;status:'AVAILABLE'|'NOT FOUND'|'UNSUPPORTED VERSION';version:string;required:boolean;guidance:string;}
export async function hasCredential(){try{await runBinary('/usr/bin/security',['find-generic-password','-s','com.winthecloud.studio','-a','openai'],{timeoutMs:5000});return true;}catch{return false;}}
export async function keychainCredential(){const result=await runBinary('/usr/bin/security',['find-generic-password','-s','com.winthecloud.studio','-a','openai','-w'],{timeoutMs:10000});return result.stdout.trim();}
export async function doctor(root=defaultRoot()) {
 const checks:Check[]=[{name:'macOS',status:process.platform==='darwin'?'AVAILABLE':'UNSUPPORTED VERSION',version:os.release(),required:true,guidance:'The desktop app requires macOS 14 or newer.'},{name:'Architecture',status:['arm64','x64'].includes(process.arch)?'AVAILABLE':'UNSUPPORTED VERSION',version:process.arch,required:true,guidance:'Apple Silicon and Intel Macs are supported.'},{name:'Node.js',status:Number(process.versions.node.split('.')[0])>=24?'AVAILABLE':'UNSUPPORTED VERSION',version:process.versions.node,required:true,guidance:'Install Node.js 24 or newer (nodejs.org).'}];
 if(process.platform==='darwin'){try{checks[0].version=(await runBinary('/usr/bin/sw_vers',['-productVersion'],{timeoutMs:5000})).stdout.trim();}catch{/* Kernel version is still available. */}}
 const tools=await Promise.all((['pnpm','ffmpeg','ffprobe','blender'] as const).map(async tool=>{try{const binary=await executable(tool);const {stdout,stderr}=await runBinary(binary,[tool==='ffmpeg'||tool==='ffprobe'?'-version':'--version'],{timeoutMs:15000});return {name:tool,status:'AVAILABLE' as const,version:(stdout||stderr).split('\n')[0],required:tool==='ffmpeg'||tool==='ffprobe',guidance:binary};}catch{return {name:tool,status:'NOT FOUND' as const,version:'',required:tool==='ffmpeg'||tool==='ffprobe',guidance:`Install ${tool} or set WTS_${tool.toUpperCase()}_PATH. ${tool==='blender'?'Optional; 3D is not required for this MVP.':''}`};}}));checks.push(...tools);
 checks.push({name:'Remotion',status:'AVAILABLE',version:'4.0.525',required:true,guidance:'First render downloads Chrome Headless Shell if absent.'});
 try{await access(resolveApp());const plist=path.join(resolveApp(),'Contents/Info.plist');const version=(await runBinary('/usr/libexec/PlistBuddy',['-c','Print CFBundleShortVersionString',plist],{timeoutMs:5000})).stdout.trim();checks.push({name:'DaVinci Resolve',status:'AVAILABLE',version,required:false,guidance:'Detection does not prove scripting access. Use FCPXML import or test the Resolve connection.'});}catch{checks.push({name:'DaVinci Resolve',status:'NOT FOUND',version:'',required:false,guidance:'Optional: preview and timeline exports work without Resolve. Set WTS_RESOLVE_APP for a custom installation.'});}
 checks.push({name:'OpenAI credentials',status:await hasCredential()?'AVAILABLE':'NOT FOUND',version:'macOS Keychain',required:false,guidance:'Save an API key in the app’s Settings to enable OpenAI. Mock mode needs no key.'});
 try{await mkdir(root,{recursive:true});await access(root,constants.W_OK);checks.push({name:'Project directory',status:'AVAILABLE',version:root,required:true,guidance:'Local files; metadata in studio.sqlite.'});}catch{checks.push({name:'Project directory',status:'NOT FOUND',version:root,required:true,guidance:'Choose a writable WTS_HOME directory.'});}
 return {checks,overall:checks.some(c=>c.required&&c.status!=='AVAILABLE')?'ACTION REQUIRED':'READY',providerDefault:'mock'};
}
