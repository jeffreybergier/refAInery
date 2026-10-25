import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import disabled, { createWorkflowExtension } from '../source/extensions/workflow.ts';

// Registration/host-boundary tests. Real TypeBox validation is exercised by
// the pinned Pi SDK integration.
const Type = {
  String: (options) => ({type:'string',...options}),
  Literal: (value) => ({const:value}),
  Union: (values) => ({anyOf:values}),
  Object: (properties,options) => ({type:'object',properties,...options}),
};

test('personalities expose only their workflow tools',async()=>{
  for(const id of ['orchestrator','worker']) {
    const agent=JSON.parse(await readFile(new URL(`../config/agents/${id}.json`,import.meta.url),'utf8'));
    const tools=[];
    createWorkflowExtension(Type,agent.availableTools,async()=>({saved:true}))({registerTool:(tool)=>tools.push(tool)});
    assert.deepEqual(tools.map(t=>t.name),id==='worker' ? ['submit_handover'] : ['update_plan','assign_subagent','finish_run']);
    assert.ok(tools.every(t=>t.executionMode==='sequential'));
  }
});

test('tools await bound host persistence; only handoff/assignment/finalization terminate',async()=>{
  const names=['update_plan','assign_subagent','submit_handover','finish_run'];const tools=[];const calls=[];
  createWorkflowExtension(Type,names,async(...args)=>{calls.push(args);return {saved:true}})({registerTool:t=>tools.push(t)});
  for(const tool of tools) {
    const result=await tool.execute('call-1',{markdown:'plan'});
    assert.equal(result.terminate,tool.name!=='update_plan');
    assert.deepEqual(result.details,{saved:true});
    assert.equal(calls.at(-1)[1],tool.name);
  }
});

test('host failure is not acknowledged; default load registers nothing',async()=>{
  const tools=[];const pi={registerTool:t=>tools.push(t)};disabled(pi);assert.equal(tools.length,0);
  createWorkflowExtension(Type,['submit_handover'],async()=>{throw Error('disk failure')})(pi);
  await assert.rejects(tools[0].execute('call',{}),/disk failure/);
});
