import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadConfiguration } from '../source/backend/config.ts';
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
  const config = await loadConfiguration(fileURLToPath(new URL('../config/', import.meta.url)));
  for(const agent of config.personalities) {
    const id = agent.id;
    const tools=[];
    createWorkflowExtension(Type,agent.availableTools,async()=>({saved:true}))({registerTool:(tool)=>tools.push(tool)});
    assert.deepEqual(tools.map(t=>t.name),id==='worker' ? ['finish_task'] : ['update_plan','spawn_subagent','finish_request']);
    assert.ok(tools.every(t=>t.executionMode==='sequential'));
  }
});

test('tools await bound host persistence; only handoff/assignment/finalization terminate',async()=>{
  const names=['update_plan','spawn_subagent','finish_task','finish_request'];const tools=[];const calls=[];
  createWorkflowExtension(Type,names,async(...args)=>{calls.push(args);return {saved:true}})({registerTool:t=>tools.push(t)});
  for(const tool of tools) {
    const result=await tool.execute('call-1',{markdown:'plan'});
    assert.equal(result.terminate,tool.name!=='update_plan');
    assert.deepEqual(result.details,{saved:true});
    assert.equal(calls.at(-1)[1],tool.name);
  }
});

test('finish schemas expose the new outcome contracts', () => {
  const tools = [];
  createWorkflowExtension(Type, ['finish_task', 'finish_request'], async () => ({}))({registerTool: tool => tools.push(tool)});
  assert.deepEqual(tools[0].parameters.properties.stopReason.anyOf.map(item => item.const), ['success', 'failure', 'context-limit']);
  assert.deepEqual(tools[1].parameters.properties.outcome.anyOf.map(item => item.const), ['success', 'failure', 'question']);
});

test('host failure is not acknowledged; default load registers nothing',async()=>{
  const tools=[];const pi={registerTool:t=>tools.push(t)};disabled(pi);assert.equal(tools.length,0);
  createWorkflowExtension(Type,['finish_task'],async()=>{throw Error('disk failure')})(pi);
  await assert.rejects(tools[0].execute('call',{}),/disk failure/);
});
