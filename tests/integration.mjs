// End-to-end Pi, sandbox, persistence and shared HTTP reader. No model service.
import assert from 'node:assert/strict';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { runOnce } from '../source/backend/runner.ts';
import { loadScenario } from '../source/backend/scenario.ts';
import { modelConfiguration } from '../source/environment.ts';
import { Store } from '../source/backend/storage.ts';
import { loadProduction } from '../source/backend/workflow.ts';
import { createAppServer } from '../source/server.ts';

const storage = process.env.REFAINERY_CHECK_STORAGE;
assert.ok(storage, 'check.sh supplies disposable storage');
const config = '/app/config';
const model = await modelConfiguration(config);
const scenario = await loadScenario(config, 'happy-path');
const options = { storage, config, prompt: scenario.prompt, scenario,
  selectedModel: model.model, registryURL: join(config, model.registry), apiKey: '' };
const result = await runOnce(options);
assert.equal(result.outcome, 'completed');
const store = new Store(storage);
const data = await loadProduction(store);
assert.equal(data.runs.length, 1);
assert.equal(data.inferences.length, scenario.responses.length);
assert.ok(data.inferences.every(call => call.provider === 'faux' && call.actualModel === null));
assert.ok(data.inferences.every(call => call.normalizedUsage.source === 'faux-estimate'));
assert.equal(data.documents.filter(doc => doc.kind === 'html').length, 2);
assert.equal(data.registry.provider, 'faux');
assert.equal(data.registry.nextAttemptAt, null);
const run = data.runs[0];
assert.equal(run.checkpoints.at(-1).status, 'completed');
assert.equal(await readFile(store.path('runs', result.runId, 'workspace/hello.txt'), 'utf8'), 'Hello from refAInery.\n');
const sessions = await readdir(store.path('runs', result.runId, 'sessions'));
assert.equal(sessions.length, 2);
const entries = (await Promise.all(sessions.map(file => readFile(store.path('runs', result.runId, 'sessions', file), 'utf8'))))
  .flatMap(text => text.trim().split('\n').map(line => JSON.parse(line)));
const tools = entries.filter(e => e.type === 'message' && e.message.role === 'toolResult');
for (const name of ['update_plan', 'assign_subagent', 'write', 'read', 'edit', 'bash', 'submit_handover', 'finish_run']) {
  assert.ok(tools.some(e => e.message.toolName === name && !e.message.isError), name);
}
for (const mode of ['test', 'prod']) {
  const server = createAppServer(undefined, store, mode);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const response = await (await fetch(origin + '/api/v1/preview')).json();
    assert.equal(response.environment, mode);
    assert.equal(response.mode, mode === 'test' ? 'test' : 'production');
    assert.equal(response.recordSource, 'saved');
    assert.equal(response.runs.length, 1);
    for (const doc of response.documents) assert.equal((await fetch(origin + doc.url)).status, 200);
    const oldView = await fetch(origin + '/v2', { redirect: 'manual' });
    assert.equal(oldView.headers.get('location'), '/v1');
  } finally {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
}
// Scripted errors use the real interruption path too; keep them out of the
// completed dataset used by the browser checks.
for (const [name, responses] of [
  ['provider-error', [{agent:'orchestrator', error:'Scripted inference failure'}]],
  ['exhausted', [{agent:'orchestrator', tool:'update_plan', arguments:{markdown:'# Plan'}}]],
  ['tool-error', scenario.responses.map((step, index) => index === 5
    ? {...step, arguments:{command:'exit 7'}} : step)],
]) {
  const failedRoot = join(storage, name);
  await mkdir(failedRoot);
  await assert.rejects(runOnce({...options, storage: failedRoot, scenario:{...scenario, responses}}), /Milestone incomplete/);
  const failed = await loadProduction(new Store(failedRoot));
  assert.equal(failed.runs[0].checkpoints.at(-1).phase, 'recovery-required');
}
console.log('Integration passed: real Pi tools/sessions/exports, both environment readers, and scripted failures.');
