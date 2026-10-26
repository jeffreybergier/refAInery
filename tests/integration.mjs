// End-to-end Pi, sandbox, persistence and shared HTTP reader. No model service.
import assert from 'node:assert/strict';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runOnce } from '../source/backend/runner.ts';
import { loadScenario } from '../source/backend/scenario.ts';
import { modelConfiguration } from '../source/environment.ts';
import { Store } from '../source/backend/storage.ts';
import { loadProduction } from '../source/backend/workflow.ts';
import { createAppServer } from '../source/server.ts';
import { loadConfiguration } from '../source/backend/config.ts';
import { firstPrompt as orchestratorFirstPrompt } from '../source/agents/orchestrator.ts';
import { firstPrompt as subagentFirstPrompt, instructionsPrompt } from '../source/agents/subagent.ts';

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
for (const name of ['update_plan', 'spawn_subagent', 'write', 'read', 'edit', 'bash', 'finish_task', 'finish_request']) {
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
// Optional personalities: the same complete workflow works with no agent files.
const defaultConfig = join(storage, 'default-config');
const defaultStorage = join(storage, 'default-run');
await mkdir(defaultConfig);
await mkdir(defaultStorage);
const defaultResult = await runOnce({ ...options, config: defaultConfig, storage: defaultStorage });
assert.equal(defaultResult.outcome, 'completed');
const defaults = (await loadProduction(new Store(defaultStorage))).runs[0].checkpoints.at(-1).configuration;
assert.ok(defaults.agentText.subagent.contextHandback);
assert.ok(defaults.personalities.every(p => !p.personalityPrompts));
assert.ok(defaults.personalities[1].instructions.includes('## Critical Context'));

// Exercise every new outcome through the real Pi schemas and runner, including
// questions before dispatch. Keep these separate from the browser dataset.
for (const [name, outcome, stopReason, beforeDispatch] of [
  ['worker-failure', 'failure', 'failure', false],
  ['context-handback', 'failure', 'context-limit', false],
  ['question-after-review', 'question', 'success', false],
  ['question-before-dispatch', 'question', null, true],
  ['failure-before-dispatch', 'failure', null, true],
]) {
  const root = join(storage, name);
  await mkdir(root);
  const finish = { ...scenario.responses.at(-1), arguments: {
    outcome, summary: 'Which target should be used?', rationale: 'Essential target missing.',
  } };
  const responses = beforeDispatch ? [scenario.responses[0], finish]
    : scenario.responses.map(step => step.tool === 'finish_request' ? finish
      : step.tool === 'finish_task' ? { ...step, arguments: { ...step.arguments, stopReason } } : step);
  const result = await runOnce({ ...options, storage: root, scenario: { ...scenario, responses } });
  assert.equal(result.outcome, outcome === 'question' ? 'waiting-for-user' : 'failed');
  const data = await loadProduction(new Store(root));
  const state = data.runs[0].checkpoints.at(-1);
  assert.equal(state.phase, outcome === 'question' ? 'waiting-for-user' : 'ended');
  assert.equal(state.endedAt === null, outcome === 'question');
  assert.equal(state.resultSummary, finish.arguments.summary);
  assert.equal(state.orchestrator.export.state, 'saved');
  assert.equal(state.tasks.length, beforeDispatch ? 0 : 1);
  assert.equal(data.inferences.length, responses.length);
  if (!beforeDispatch) assert.equal(state.tasks[0].attempts[0].stopReason, stopReason);
}
// Exercise every personality addition through the resolved run configuration.
{
  const promptConfig = join(storage, 'prompt-config');
  await mkdir(join(promptConfig, 'agents'), { recursive: true });
  for (const [id, role, prompts] of [
    ['orchestrator', 'orchestrator', { instructions: 'Test orchestrator personality',
      firstPrompt: 'Test initial orchestrator guidance',
      firstReply: 'Test orchestrator seed {{ OPTIONAL_PERSONALITY_ADDITION }}',
      finalAnswer: 'Test orchestrator completion reminder', subagentReview: 'Test handover review guidance' }],
    ['worker', 'subagent', { instructions: 'Test worker personality', firstPrompt: 'Test initial worker guidance',
      firstReply: 'Test worker seed', finalAnswer: 'Test worker completion reminder' }],
  ]) {
    await writeFile(join(promptConfig, 'agents', `${id}.json`), JSON.stringify({ schemaVersion: 1, id, name: id, role, prompts }));
  }
  const resolved = await loadConfiguration(promptConfig);
  const { orchestrator: orchestratorText, subagent: subagentText } = resolved.agentText;
  for (const repair of [false, true]) {
    const root = join(storage, repair ? 'text-only-repair' : 'no-spurious-reminder');
    await mkdir(root);
    const responses = scenario.responses.flatMap(step => repair &&
      ['spawn_subagent', 'finish_task', 'finish_request'].includes(step.tool)
      ? [{ agent: step.agent, text: 'A text-only final answer without the required tool.' }, step] : [step]);
    const result = await runOnce({ ...options, config: promptConfig, storage: root, scenario: { ...scenario, responses } });
    assert.equal(result.outcome, 'completed');
    const store = new Store(root), saved = await loadProduction(store);
    assert.equal(saved.inferences.length, responses.length); // Seeds are not model calls.
    const state = saved.runs[0].checkpoints.at(-1);
    assert.deepEqual(state.configuration.agentText, resolved.agentText);
    assert.deepEqual(state.configuration.agentTemplates, resolved.agentTemplates);
    assert.deepEqual(state.configuration.personalities.map(p => p.personalityPrompts), resolved.personalities.map(p => p.personalityPrompts));
    for (const [sessionPath, text, reminderCount] of [
      [state.orchestrator.sessionPath, orchestratorText, repair ? 2 : 0],
      [state.tasks[0].attempts[0].sessionPath, subagentText, repair ? 1 : 0],
    ]) {
      const messages = (await readFile(store.path('runs', result.runId, sessionPath), 'utf8'))
        .trim().split('\n').map(line => JSON.parse(line)).filter(entry => entry.type === 'message').map(entry => entry.message);
      const content = message => typeof message.content === 'string' ? message.content
        : message.content.filter(part => part.type === 'text').map(part => part.text).join('');
      const seeds = messages.filter(message => message.role === 'assistant' && message.provider === 'refainery');
      assert.equal(seeds.length, 1);
      assert.equal(content(seeds[0]), text.firstReply);
      assert.ok(messages.some(message => message.role === 'system' &&
        [content(message), ...Object.values(message.sections ?? {})].some(section =>
          typeof section === 'string' && section.includes((text === subagentText
            ? instructionsPrompt(text.instructions, text.handover) : text.instructions).trim()))));
      const firstUser = messages.findIndex(message => message.role === 'user');
      const task = state.tasks[0];
      const expectedPrompt = text === orchestratorText
        ? orchestratorFirstPrompt(scenario.prompt, text.firstPrompt, text.planTemplate)
        : subagentFirstPrompt(task.assignment, text.firstPrompt, {
          request: scenario.prompt,
          plan: await readFile(store.path('runs', result.runId, task.attempts[0].planRevision), 'utf8'),
          handoverTemplate: text.handover,
        });
      assert.equal(content(messages[firstUser]), expectedPrompt);
      assert.equal(messages[firstUser + 1], seeds[0]);
      assert.equal(messages.filter(message => message.role === 'user' && content(message) === text.finalAnswer).length, reminderCount);
      if (text === orchestratorText) assert.ok(messages.some(message => message.role === 'user' &&
        content(message).startsWith(orchestratorText.subagentReview)));
    }
  }
  // Two text-only stops exhaust the single reminder; no implicit completion.
  for (const [name, responses] of [
    ['orchestrator-ignores-reminder', [{ agent: 'orchestrator', text: 'Done' }, { agent: 'orchestrator', text: 'Still done' }]],
    ['worker-ignores-reminder', [...scenario.responses.slice(0, 2),
      { agent: 'worker', text: 'Done' }, { agent: 'worker', text: 'Still done' }]],
  ]) {
    const root = join(storage, name);
    await mkdir(root);
    await assert.rejects(runOnce({ ...options, config: promptConfig, storage: root, scenario: { ...scenario, responses } }), /Milestone incomplete/);
    const saved = await loadProduction(new Store(root));
    assert.equal(saved.inferences.length, responses.length);
    assert.equal(saved.runs[0].checkpoints.at(-1).phase, 'recovery-required');
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
