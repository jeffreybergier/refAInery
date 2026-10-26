import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, identity, now, names } from '../source/backend/storage.ts';
import { Registry, validateCatalog } from '../source/backend/registry.ts';
import { Workflow, enqueue, queuedRequests, loadProduction, notDue } from '../source/backend/workflow.ts';
import { observeProvider, PiAdapter } from '../source/backend/pi.ts';
import { createAppServer } from '../source/server.ts';
import { workflowPresentation } from '../source/public/workflow.js';
import { nativeExport, withLegacyFallback } from './helpers/pi-export.mjs';
import { validateCheckpoint } from '../source/backend/validation.ts';

const configuration = () => ({ id: identity('config'), personalities: [], extensions: [], sdkVersion: '1.4.0',
  toolCatalogVersion: 'refainery-tools-v3', models: [{id:'default',provider:'openrouter',modelId:'requested-alias',contextWindow:250000}], orchestratorModel:'default' });
const catalog = () => ({ data: [{id:'requested-alias', context_length:300000, pricing:{prompt:'0.000001',completion:'0.000002'}, supported_parameters:['tools']}], total_count:1, links:{next:null} });
const handover = '## Goal\nTest\n## Constraints & Preferences\nNone\n## Progress\n### Done\nVerified\n### In Progress\nNone\n### Blocked\nNone\n## Key Decisions\nNone\n## Next Steps\nNone\n## Critical Context\nNone\n<read-files>\n</read-files>\n<modified-files>\n</modified-files>\n';
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(),'refainery-backend-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  return new Store(root);
}
async function planning(t) {
  const store=await setup(t), request=await enqueue(store,'Preserve this prompt.\n');
  const flow=new Workflow(store,request,configuration());
  flow.state.orchestrator.sessionId='session-orchestrator';flow.state.orchestrator.sessionPath='sessions/orchestrator.jsonl';
  await store.document(`${flow.prefix}/sessions/orchestrator.jsonl`, 'test-only session placeholder\n');
  await flow.save();await flow.beginTurn();return {store,flow,request};
}
const action=(f,id,name,args)=>f.action('orchestrator','session-orchestrator',id,name,args);
const assignment={personality:'worker',model:'default',title:'Small task',assignment:'Do it',rationale:'Next step'};

test('immutable atomic records and exclusive writer lock',async(t)=>{
  const store=await setup(t);await store.acquire();
  await assert.rejects(new Store(store.root).acquire());
  await store.save('immutable.json',{value:1});await assert.rejects(store.save('immutable.json',{value:2}));
  assert.equal(JSON.parse(await readFile(store.path('immutable.json'),'utf8')).value,1);
  await store.release();await store.acquire();await store.release();
});

test('FIFO intake preserves prompts and unfinished runs block dispatch',async(t)=>{
  const store=await setup(t);const r=await enqueue(store,' x\n');
  assert.equal((await queuedRequests(store))[0].prompt,' x\n');
  const flow=new Workflow(store,r,configuration());await flow.save();
  await assert.rejects(queuedRequests(store),/recovery/);
});

test('role/session authority, idempotent calls and optional plan revision history',async(t)=>{
  const {flow,store}=await planning(t);
  await assert.rejects(flow.action('orchestrator','wrong','p','update_plan',{markdown:'plan'}),/planning/);
  await assert.rejects(flow.action('subagent','worker','p','update_plan',{markdown:'plan'}),/authorized/);
  const saved=await action(flow,'p','update_plan',{markdown:'# Plan\nFirst'});
  assert.deepEqual(await action(flow,'p','update_plan',{markdown:'# Plan\nFirst'}),saved);
  await assert.rejects(action(flow,'p','update_plan',{markdown:'changed'}),/reused/);
  assert.equal(flow.state.plans.length,1);
  await action(flow,'p2','update_plan',{markdown:'# Plan\nSecond'});
  assert.equal(await readFile(store.path(flow.prefix,'plans/000001.md'),'utf8'),'# Plan\nFirst');
  await action(flow,'a','spawn_subagent',assignment);
  assert.equal(flow.state.pendingAction.kind,'assign');
  await assert.rejects(action(flow,'late','update_plan',{markdown:'late'}),/planning/);
});

test('write failure poisons workflow and prevents later actions',async(t)=>{
  const {flow,store}=await planning(t);
  store.save=async()=>{throw Error('simulated disk failure')};
  await assert.rejects(action(flow,'p','update_plan',{markdown:'plan'}));
  await assert.rejects(action(flow,'a','spawn_subagent',assignment),/degraded/);
});

async function handback(t, stopReason = 'success', { plan = true, markdown = handover } = {}) {
  const context=await planning(t);const {flow,store}=context;
  if (plan) await action(flow,'plan1','update_plan',{markdown:'# Initial plan'});
  await action(flow,'assign','spawn_subagent',assignment);await flow.endTurn();
  flow.state.pendingAction=null;flow.state.phase='executing';
  flow.state.tasks[0].attempts.push({id:'attempt-one',title:'Small task',number:1,model:'default',personality:'worker',
    sessionId:'session-worker',sessionPath:'sessions/worker.jsonl',status:'running',startedAt:now(),endedAt:null,
    handover:null,export:notDue(),stopReason:null,review:'not-submitted',reviewedAt:null,retryReason:null,planRevision:flow.state.plan});
  await store.document(`${flow.prefix}/sessions/worker.jsonl`, 'test-only session placeholder\n');
  await flow.save();
  await assert.rejects(flow.action('subagent','wrong','h','finish_task',{markdown:handover,stopReason}));
  await assert.rejects(flow.action('subagent','session-worker','bad','finish_task',{markdown:'',stopReason}));
  await assert.rejects(flow.action('subagent','session-worker','legacy','submit_handover',{markdown:handover,stopReason}),/authorized/);
  await assert.rejects(flow.action('subagent','session-worker','invalid','finish_task',{markdown:handover,stopReason:'completed'}),/stop reason/);
  await assert.rejects(flow.action('subagent','session-worker','scope','finish_request',{outcome:'success',summary:'done',rationale:'done'}),/authorized/);
  await flow.action('subagent','session-worker','h','finish_task',{markdown,stopReason});
  assert.equal(flow.state.phase,'stopping-worker');
  const a=flow.state.tasks[0].attempts[0];a.endedAt=now();a.status='completed';
  a.export={state:'pending',path:null,error:null};await flow.save();
  await store.document(`${flow.prefix}/exports/worker.html`,'<html>Worker session</html>');
  flow.state.tasks[0].attempts[0].export={state:'saved',path:'exports/worker.html',error:null};
  flow.state.tasks[0].attempts[0].review='pending';flow.state.phase='awaiting-review';await flow.save();
  return context;
}

test('handover -> new plan -> decision uses real saved documents and no acceptance fiction',async(t)=>{
  const {flow,store}=await handback(t);
  await flow.beginTurn();
  await action(flow,'plan2','update_plan',{markdown:'# Final plan\nDone'});
  await action(flow,'finish','finish_request',{outcome:'success',summary:'done',rationale:'checked'});await flow.endTurn();
  assert.equal(flow.state.tasks[0].attempts[0].review,'decided');
  await store.document(`${flow.prefix}/exports/orchestrator.html`,'<html>Final session</html>');
  flow.state.orchestrator.export={state:'saved',path:'exports/orchestrator.html',error:null};
  await flow.finishRequest();
  assert.equal(flow.state.status,'completed');
  assert.ok(flow.state.endedAt);
  const data=await loadProduction(store), view=workflowPresentation(data);
  assert.equal(data.mode,'production');assert.equal(data.documents.length,5);
  assert.equal(view.operations.outcomes.decided,1);assert.equal(view.operations.outcomes.accepted,0);
  assert.equal(view.runs[0].plans.length,2);assert.equal((await queuedRequests(store)).length,0);
});

test('workers can start without a plan and submit arbitrary nonempty handover Markdown', async t => {
  const markdown = 'Completed the task. Checked the output.';
  const { flow, store } = await handback(t, 'success', { plan: false, markdown });
  assert.equal(flow.state.plan, null);
  assert.deepEqual(flow.state.plans, []);
  assert.equal(flow.state.tasks[0].attempts[0].planRevision, null);
  assert.equal(flow.state.decisions[0].plan, null);
  assert.equal(await readFile(store.path(flow.prefix, flow.state.tasks[0].attempts[0].handover), 'utf8'), markdown);
  const data = await loadProduction(store);
  assert.equal(workflowPresentation(data).runs[0].plan, undefined);
  const invalid = structuredClone(flow.state);
  invalid.tasks[0].attempts[0].planRevision = 'plans/missing.md';
  assert.throws(() => validateCheckpoint(invalid), /handback/);
});

for (const plan of [false, true]) {
  test(`another worker can be assigned after handover without updating the ${plan ? 'existing' : 'absent'} plan`, async t => {
    const { flow, store } = await handback(t, 'success', { plan });
    await flow.beginTurn();
    const receipt = await action(flow, 'verify', 'spawn_subagent', { ...assignment, title: 'Verify previous work' });
    assert.deepEqual(await action(flow, 'verify', 'spawn_subagent', { ...assignment, title: 'Verify previous work' }), receipt);
    assert.equal(flow.state.tasks.length, 2);
    assert.equal(flow.state.tasks[0].attempts[0].review, 'decided');
    assert.equal(flow.state.pendingAction.kind, 'assign');
    assert.equal(flow.state.decisions.at(-1).plan, flow.state.plan);
    assert.equal(flow.state.plans.length, plan ? 1 : 0);
    assert.equal((await loadProduction(store)).runs[0].checkpoints.at(-1).tasks.length, 2);
  });
}

test('historical tool-catalog checkpoints remain readable', async (t) => {
  const { flow } = await handback(t);
  const old = structuredClone(flow.state);
  old.configuration.toolCatalogVersion = 'refainery-tools-v1';
  old.tasks[0].attempts[0].stopReason = 'completed';
  for (const decision of old.decisions) decision.action = 'assign_subagent';
  for (const receipt of Object.values(old.receipts)) {
    if (receipt.action === 'spawn_subagent') receipt.action = 'assign_subagent';
    if (receipt.action === 'finish_task') receipt.action = 'submit_handover';
  }
  assert.doesNotThrow(() => validateCheckpoint(old));
});

for (const stopReason of ['failure', 'context-limit']) {
  test(`worker ${stopReason} hands back without finishing the request`, async (t) => {
    const { flow, store } = await handback(t, stopReason);
    assert.equal(flow.state.tasks[0].attempts[0].stopReason, stopReason);
    assert.equal(flow.state.status, 'running');
    assert.equal(flow.state.phase, 'awaiting-review');
    assert.equal((await loadProduction(store)).runs.length, 1);
  });
}

for (const outcome of ['success', 'failure', 'question']) {
  for (const afterWorker of [false, true]) {
    test(`${outcome} ${afterWorker ? 'after review' : 'before dispatch'} is persisted honestly`, async (t) => {
      const { flow, store } = await (afterWorker ? handback(t) : planning(t));
      if (afterWorker) await flow.beginTurn();
      const args = { outcome, summary: 'Which target should be used?', rationale: 'Essential target missing.' };
      await assert.rejects(action(flow, 'old', 'finish_run', args), /authorized/);
      await assert.rejects(action(flow, 'bad', 'finish_request', { ...args, outcome: 'completed' }), /outcome/);
      const receipt = await action(flow, 'finish', 'finish_request', args);
      assert.deepEqual(await action(flow, 'finish', 'finish_request', args), receipt);
      await assert.rejects(flow.finishRequest(), /durable/);
      await flow.endTurn();
      await assert.rejects(flow.finishRequest(), /durable/);
      await store.document(`${flow.prefix}/exports/orchestrator.html`, '<html>Question or failure</html>');
      flow.state.orchestrator.export = { state: 'saved', path: 'exports/orchestrator.html', error: null };
      await flow.finishRequest();
      const saved = (await loadProduction(store)).runs[0].checkpoints.at(-1);
      assert.equal(saved.resultSummary, args.summary);
      assert.equal(saved.pendingAction, null);
      assert.equal(saved.status, { success: 'completed', failure: 'failed', question: 'waiting-for-user' }[outcome]);
      assert.equal(saved.plans.length, afterWorker ? 1 : 0);
      assert.equal(saved.decisions.at(-1).plan, afterWorker ? saved.plan : null);
      assert.equal(saved.phase, outcome === 'question' ? 'waiting-for-user' : 'ended');
      assert.equal(saved.endedAt === null, outcome === 'question');
      assert.equal(saved.tasks.length, afterWorker ? 1 : 0);
      assert.equal(workflowPresentation(await loadProduction(store)).runs[0].status, saved.status);
      if (outcome === 'question') {
        await assert.rejects(queuedRequests(store), /recovery/);
        for (const change of [
          { endedAt: now() }, { resultSummary: null }, { phase: 'ended' },
          { pendingAction: { kind: 'assign' } }, { failure: 'interrupted' },
          { orchestrator: { ...saved.orchestrator, export: notDue() } },
        ]) assert.throws(() => validateCheckpoint({ ...saved, ...change }), /boundary/);
      } else assert.deepEqual(await queuedRequests(store), []);
      await assert.rejects(flow.beginTurn(), /not active/);
      await assert.rejects(action(flow, 'late', 'update_plan', { markdown: 'late' }), /not active/);
    });
  }
}

test('production API serves only referenced documents, never sessions; corruption fails closed',async(t)=>{
  const {store,flow}=await handback(t);
  const server=createAppServer(undefined,store);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>server.close(r)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const result=await (await fetch(base+'/api/v1/preview')).json();
  assert.equal(result.mode,'production');
  const doc=await fetch(base+result.documents.find(d=>d.kind==='html').url);
  assert.match(doc.headers.get('content-security-policy'),/sandbox;/);
  assert.equal((await fetch(base+`/production/v1/documents/${flow.state.runId}/sessions/worker.jsonl`)).status,404);
  assert.equal((await fetch(base+`/production/v1/documents/${flow.state.runId}/plans/unknown.md`)).status,404);
  const files=await names(store.path(flow.prefix,'checkpoints'));
  await writeFile(store.path(flow.prefix,'checkpoints',files.at(-1)),'invalid');
  assert.equal((await fetch(base+'/api/v1/preview')).status,503);
});

test('production route repairs legacy Pi presentation only; HEAD agrees and Markdown stays script-free',async(t)=>{
  const {store,flow}=await handback(t), {html}=await nativeExport(store.root);
  const file=store.path(flow.prefix,'exports/worker.html'), legacy=withLegacyFallback(html);
  await writeFile(file,legacy);
  const server=createAppServer(undefined,store);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>server.close(r)));
  const base=`http://127.0.0.1:${server.address().port}/production/v1/documents/${flow.state.runId}/`;
  const get=await fetch(base+'exports/worker.html'),head=await fetch(base+'exports/worker.html',{method:'HEAD'});
  assert.equal(get.status,200);assert.equal(await get.text(),html);
  assert.match(get.headers.get('content-security-policy'),/^sandbox allow-scripts allow-downloads;/);
  assert.equal(head.headers.get('content-security-policy'),get.headers.get('content-security-policy'));
  assert.equal(await head.text(),'');assert.equal(await readFile(file,'utf8'),legacy);
  assert.match((await fetch(base+'plans/000001.md')).headers.get('content-security-policy'),/^sandbox;/);
  assert.equal((await fetch(base+'pi-private/orchestrator.html')).status,404);
  await writeFile(file,html.replace('<body>','<body><script>window.pwned=1</script>'));
  assert.match((await fetch(base+'exports/worker.html')).headers.get('content-security-policy'),/^sandbox;/);
});

test('missing stopped Pi session is an error, not a transcript-based fallback',async(t)=>{
  const {store,flow}=await handback(t);
  await rm(store.path(flow.prefix,'sessions/worker.jsonl'));
  await assert.rejects(loadProduction(store));
});

test('frozen configuration cannot change between checkpoints',async(t)=>{
  const {flow}=await planning(t);
  flow.state.configuration.models[0].modelId='different-model';
  await assert.rejects(flow.save(),/checkpoint chain/);
});

test('referenced document symlink escape fails closed',async(t)=>{
  const {store,flow}=await planning(t);await action(flow,'p','update_plan',{markdown:'plan'});
  const file=store.path(flow.prefix,flow.state.plan);await rm(file);await symlink('/etc/passwd',file);
  await assert.rejects(loadProduction(store),/location/);
});

test('registry snapshots retain unchanged observations, prices and prior history',async(t)=>{
  const store=await setup(t);let calls=0;
  const reg=new Registry(store,'https://openrouter.ai/api/v1/models',async()=>{calls++;return Response.json(catalog())});
  await reg.start();t.after(()=>reg.stop());const first=reg.current.id;
  await Promise.all([reg.refresh(),reg.refresh()]);
  assert.equal(calls,2);assert.notEqual(reg.current.id,first);
  assert.equal((await names(store.path('registry/snapshots'))).length,2);
  assert.equal(reg.current.models[0].pricing.prompt,'0.000001');
  reg.current.fetchedAt=new Date(Date.now()-3600001).toISOString();assert.equal(reg.reference().registryFreshness,'stale');
});

test('registry failure retains last good catalog and records degraded status',async(t)=>{
  const store=await setup(t);let fail=false;
  const reg=new Registry(store,'https://openrouter.ai/api/v1/models',async()=>{if(fail)throw Error('network');return Response.json(catalog())});
  await reg.refresh();const id=reg.current.id;fail=true;await reg.refresh();
  assert.equal(reg.current.id,id);
  assert.equal(JSON.parse(await readFile(store.path('registry/status.json'),'utf8')).error,'registry-refresh-failed');
});

test('registry rejects partial catalogs and preserves unavailable-price sentinel',async(t)=>{
  assert.throws(()=>validateCatalog({data:[]}));
  assert.throws(()=>validateCatalog({data:[{...catalog().data[0],pricing:{prompt:'nonsense'}}]}));
  assert.equal(validateCatalog({data:[{...catalog().data[0],pricing:{prompt:'-1'}}]})[0].pricing.prompt,'-1');
  const store=await setup(t);
  const reg=new Registry(store,'https://openrouter.ai/api/v1/models',async()=>Response.json({...catalog(),links:{next:'more'}}));
  await reg.refresh();assert.equal(reg.current,null);assert.equal(reg.reference().registryFreshness,'unavailable');
});

test('registry timer refreshes while idle after one hour, not before',async(t)=>{
  const store=await setup(t);let count=0;
  t.mock.timers.enable({apis:['setTimeout']});
  const reg=new Registry(store,'https://openrouter.ai/api/v1/models',async()=>{count++;return Response.json(catalog())});
  await reg.start();t.after(()=>reg.stop());
  t.mock.timers.tick(3599999);assert.equal(count,1);
  t.mock.timers.tick(1);await reg.refresh();assert.equal(count,2);
});

test('registry persistence failure never publishes a new current snapshot',async(t)=>{
  const store=await setup(t);const reg=new Registry(store,'https://openrouter.ai/api/v1/models',async()=>Response.json(catalog()));
  await reg.refresh();const id=reg.current.id;
  store.save=async()=>{throw Error('disk failure')};await reg.refresh();
  assert.equal(reg.current.id,id);
});

test('SDK integration explicitly registers workflow tools without ambient defaults or model calls',async(t)=>{
  const store=await setup(t), request=await enqueue(store,'offline');
  const config=configuration();
  const personality={schemaVersion:1,id:'orchestrator',name:'Orchestrator',role:'orchestrator',instructions:'Offline test',availableTools:['update_plan']};
  config.personalities=[personality];const flow=new Workflow(store,request,config);
  await store.document(`${flow.prefix}/config/extensions/web-search.ts`,'export const createWebSearchExtension = () => () => {};');
  await store.document(`${flow.prefix}/config/extensions/workflow.ts`, `export const createWorkflowExtension = (Type, allowed, host) => pi => {
    pi.registerTool({name:'update_plan',label:'Plan',description:'Save plan',parameters:Type.Object({markdown:Type.String()}),
      execute:async()=>({content:[{type:'text',text:'offline'}],details:undefined})});
  };`);
  const {mkdir}=await import('node:fs/promises');const workspace=store.path(flow.prefix,'workspace');await mkdir(workspace,{recursive:true});
  const registry={current:{models:[{...catalog().data[0]}]}};
  const adapter=new PiAdapter(store,flow,registry,'requested-alias','not-a-real-key',{workspace,tools:()=>[]},0);
  await adapter.initialize();const agent=await adapter.create(personality);t.after(()=>agent.session.dispose());
  assert.deepEqual(agent.session.getActiveToolNames(),['update_plan']);
  for (const name of ['spawn_subagent', 'finish_task', 'finish_request']) {
    const toolCall = { type: 'toolCall', id: 'terminal', name, arguments: {} };
    const blocked = await agent.session.agent.beforeToolCall({ toolCall,
      assistantMessage: { content: [toolCall, { type: 'toolCall', id: 'plan', name: 'update_plan', arguments: {} }] },
    });
    assert.equal(blocked.block, true);
    assert.match(blocked.reason, /called alone/);
  }
  await assert.rejects(agent.session.agent.streamFunction(agent.session.model,{messages:[]}),/budget/);
  assert.deepEqual(await names(store.path(flow.prefix,'inferences')),[]);
});

test('actual identity comes only from provider data; usage/cost are allowlisted',()=>{
  const record={requestedModel:'alias',actualModel:null,actualModelSource:null,providerResponseId:null,providerUsage:null,reportedCost:null};
  observeProvider(record,{choices:[]});assert.equal(record.actualModel,null);
  observeProvider(record,{model:'resolved-model',id:'generation-1',usage:{prompt_tokens:12,completion_tokens:5,cost:0.001,secret:'never persist'}});
  assert.equal(record.requestedModel,'alias');assert.equal(record.actualModel,'resolved-model');
  assert.equal(record.providerResponseId,'generation-1');assert.equal(record.reportedCost.currency,'USD');
  assert.equal('secret' in record.providerUsage,false);
});
