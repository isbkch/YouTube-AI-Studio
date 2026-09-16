import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JobGraph,validateGraph} from '../packages/orchestrator/src/jobs.ts';
import {StudioError} from '../packages/shared/src/index.ts';

test('dependency graph rejects cycles and missing dependencies',()=>{
  assert.throws(()=>validateGraph([{id:'a',dependencies:['b']},{id:'b',dependencies:['a']}]));
  assert.throws(()=>validateGraph([{id:'a',dependencies:['absent']}]))
});
test('jobs retry recoverable failures, respect dependencies and concurrency',async()=>{
  let attempts=0,active=0,max=0;const order:string[]=[];
  const tasks=['a','b'].map(id=>({id,type:'render',label:id,dependencies:[],run:async()=>{active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,5));active--;order.push(id);}}));
  const graph=new JobGraph([...tasks,{id:'join',type:'assemble',label:'Join',dependencies:['a','b'],run:async()=>{assert.equal(order.length,2);if(++attempts===1)throw new StudioError('EXTERNAL_TOOL','Transient','Retry',true);}}],'p',()=>{},2);
  const jobs=await graph.run();assert.equal(max,2);assert.equal(attempts,2);assert.equal(jobs[2].retryCount,1);assert.ok(jobs.every(j=>j.status==='COMPLETE'));
});
test('failed dependency blocks assembly without rebuilding successful jobs',async()=>{
  let assembled=false;const graph=new JobGraph([{id:'a',type:'render',label:'Broken',dependencies:[],run:async()=>{throw new StudioError('INVALID_INPUT','Invalid template');}},{id:'b',type:'assemble',label:'Assembly',dependencies:['a'],run:async()=>{assembled=true;}}],'p',()=>{});
  await assert.rejects(graph.run());assert.equal(assembled,false);assert.equal(graph.jobs[1].status,'BLOCKED');
});
test('cancellation persists and prevents blocked work',async()=>{
  const abort=new AbortController();const graph=new JobGraph([{id:'a',type:'work',label:'work',dependencies:[],run:async()=>{abort.abort();}},{id:'b',type:'work',label:'next',dependencies:['a'],run:async()=>{throw Error('must not run');}}],'p',()=>{});
  await assert.rejects(graph.run(abort.signal));assert.ok(graph.jobs.every(j=>j.status==='CANCELLED'));
});
