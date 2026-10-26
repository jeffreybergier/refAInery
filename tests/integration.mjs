// End-to-end Pi, sandbox, persistence and shared HTTP reader. No model service.
import assert from 'node:assert/strict';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runOnce } from '../source/backend/runner.ts';
import { loadScenario } from '../source/backend/scenario.ts';
import { modelConfiguration } from '../source/environment.ts';
import { Store } from '../source/backend/storage.ts';
import { loadProduction } from '../source/backend/workflow.ts';
import { workflowPresentation } from '../source/public/workflow.js';
import { createAppServer } from '../source/server.ts';
import { loadConfiguration } from '../source/backend/config.ts';
import { firstPrompt as orchestratorFirstPrompt, instructionsPrompt as orchestratorInstructionsPrompt } from '../source/agents/orchestrator.ts';
import { firstPrompt as subagentFirstPrompt, instructionsPrompt } from '../source/agents/subagent.ts';

const storage = process.env.REFAINERY_CHECK_STORAGE;
assert.ok(storage, 'check.sh supplies disposable storage');
const config = '/app/config';
const model = await modelConfiguration(config);
const scenario = await loadScenario(config, 'happy-path');
// Historical configs without a selection manifest still have a worker role.
const legacyScenario = { ...scenario, responses: scenario.responses.map(step => ({
  ...step, agent: step.agent === 'implementer' ? 'worker' : step.agent,
  ...(step.tool === 'spawn_subagent' ? { arguments: { ...step.arguments, personality: 'worker' } } : {}),
})) };
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
assert.match(result.requestId, /^request-[0-9a-f]{8}-[0-9a-f]{4}$/);
const workspace = store.path('workspaces', result.requestId);
assert.equal(await readFile(join(workspace, 'hello.txt'), 'utf8'), 'Hello from refAInery.\n');
for (const personality of run.checkpoints.at(-1).configuration.personalities) {
  assert.ok(personality.instructions.includes(`/workspace/${result.requestId}`));
  assert.ok(!personality.instructions.includes('{{ CURRENT WORKING DIRECTORY }}'));
}
const sandbox = JSON.parse(await readFile(store.path('runs', result.runId, 'sandbox.json'), 'utf8'));
assert.equal(sandbox.workspace, workspace);
assert.equal(sandbox.workerWorkspace, `/workspace/${result.requestId}`);
const sessions = await readdir(store.path('runs', result.runId, 'sessions'));
assert.equal(sessions.length, 2);
const entries = (await Promise.all(sessions.map(file => readFile(store.path('runs', result.runId, 'sessions', file), 'utf8'))))
  .flatMap(text => text.trim().split('\n').map(line => JSON.parse(line)));
const sessionHeaders = entries.filter(e => e.type === 'session');
assert.equal(sessionHeaders.length, 2);
assert.ok(sessionHeaders.every(e => e.cwd === workspace));
const orchestratorSystem = entries.find(e => e.type === 'message' && e.message.role === 'system' &&
  e.message.toolsAdded?.some(tool => tool.name === 'spawn_subagent')).message;
const orchestratorSystemText = [orchestratorSystem.content, ...Object.values(orchestratorSystem.sections ?? {})].join('\n');
assert.ok(!orchestratorSystemText.includes('{{ AVAILABLE_SUBAGENTS }}'));
for (const id of ['implementer', 'tester']) {
  assert.ok(orchestratorSystemText.includes(`- "${id}"`));
}
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
const defaultResult = await runOnce({ ...options, config: defaultConfig, storage: defaultStorage, scenario: legacyScenario });
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
  ['success-before-dispatch', 'success', null, true],
]) {
  const root = join(storage, name);
  await mkdir(root);
  const finish = { ...scenario.responses.at(-1), arguments: {
    outcome, summary: 'Which target should be used?', rationale: 'Essential target missing.',
  } };
  const responses = beforeDispatch ? [finish]
    : scenario.responses.map(step => step.tool === 'finish_request' ? finish
      : step.tool === 'finish_task' ? { ...step, arguments: { ...step.arguments, stopReason } } : step);
  const result = await runOnce({ ...options, storage: root, scenario: { ...scenario, responses } });
  assert.equal(result.outcome, { success: 'completed', failure: 'failed', question: 'waiting-for-user' }[outcome]);
  const data = await loadProduction(new Store(root));
  const state = data.runs[0].checkpoints.at(-1);
  assert.equal(state.phase, outcome === 'question' ? 'waiting-for-user' : 'ended');
  assert.equal(state.endedAt === null, outcome === 'question');
  assert.equal(state.resultSummary, finish.arguments.summary);
  assert.equal(state.orchestrator.export.state, 'saved');
  assert.equal(state.tasks.length, beforeDispatch ? 0 : 1);
  if (beforeDispatch) {
    assert.equal(state.plan, null);
    assert.deepEqual(state.plans, []);
    assert.equal(state.decisions[0].plan, null);
  }
  assert.equal(data.inferences.length, responses.length);
  if (!beforeDispatch) assert.equal(state.tasks[0].attempts[0].stopReason, stopReason);
}
// Sequential verification workers share files, not running processes. Plans are
// optional and an existing revision may be reused across every review turn.
for (const withPlan of [false, true]) {
  const root = join(storage, withPlan ? 'reused-plan-workers' : 'no-plan-workers');
  await mkdir(root);
  const assign = (personality, title) => ({ agent: 'orchestrator', tool: 'spawn_subagent', arguments: {
    personality, model: 'default', title, assignment: title, rationale: 'Continue the work',
  } });
  const handback = (agent, summary) => ({ agent, tool: 'finish_task', arguments: {
    markdown: summary, stopReason: 'success',
  } });
  const workerSteps = [
    assign('implementer', 'Create the artifact'),
    { agent: 'implementer', tool: 'write', arguments: { path: 'shared.txt', content: 'Verified artifact\n' } },
    { agent: 'implementer', tool: 'bash', arguments: {
      command: 'case "$PWD" in /workspace/request-????????-????) ;; *) exit 1;; esac; pwd > cwd.txt; touch /tmp/previous-worker',
    } },
    handback('implementer', 'Created shared.txt.'),
    assign('tester', 'Verify the artifact'),
    { agent: 'tester', tool: 'read', arguments: { path: 'shared.txt' } },
    { agent: 'tester', tool: 'bash', arguments: {
      command: 'test ! -e /tmp/previous-worker && test "$(cat shared.txt)" = "Verified artifact" && test "$(cat cwd.txt)" = "$PWD"',
    } },
    handback('tester', 'Verified persisted contents in a fresh sandbox.'),
    assign('implementer', 'Review the verification findings'),
    handback('implementer', 'Reviewed the supplied findings.'),
    { agent: 'orchestrator', tool: 'finish_request', arguments: {
      outcome: 'success', summary: 'Artifact created and verified.', rationale: 'Reviewed the worker results.',
    } },
  ];
  const responses = withPlan ? [scenario.responses[0], ...workerSteps] : workerSteps;
  const result = await runOnce({ ...options, storage: root, scenario: { ...scenario, responses } });
  assert.equal(result.outcome, 'completed');
  const store = new Store(root), saved = await loadProduction(store);
  const state = saved.runs[0].checkpoints.at(-1);
  assert.equal(state.tasks.length, 3);
  assert.equal(state.orchestrator.turns.length, 4);
  assert.equal(state.plans.length, withPlan ? 1 : 0);
  assert.equal(saved.inferences.length, responses.length);
  assert.equal(state.decisions.length, 4);
  for (const decision of state.decisions) assert.equal(decision.plan, state.plan);
  const attempts = state.tasks.flatMap(task => task.attempts);
  assert.deepEqual(state.configuration.subagentIds, ['implementer', 'tester']);
  assert.deepEqual(state.tasks.map(task => task.personality), ['implementer', 'tester', 'implementer']);
  assert.deepEqual(attempts.map(attempt => attempt.personality), ['implementer', 'tester', 'implementer']);
  assert.equal(new Set(attempts.map(a => a.sessionId)).size, 3);
  assert.equal(new Set(attempts.map(a => a.export.path)).size, 3);
  for (const [index, attempt] of attempts.entries()) {
    const taskId = `task-${String(index + 1).padStart(3, '0')}`;
    assert.equal(state.tasks[index].id, taskId);
    assert.equal(attempt.id, `${taskId}-attempt-001`);
    assert.equal(attempt.planRevision, state.plan);
    assert.equal(attempt.review, 'decided');
    assert.equal(attempt.export.state, 'saved');
    const session = (await readFile(store.path('runs', result.runId, attempt.sessionPath), 'utf8'))
      .trim().split('\n').map(line => JSON.parse(line)).filter(e => e.type === 'message').map(e => e.message);
    assert.ok(!session.some(m => m.role === 'toolResult' && m.isError));
    const firstUser = session.find(m => m.role === 'user');
    const text = typeof firstUser.content === 'string' ? firstUser.content
      : firstUser.content.filter(part => part.type === 'text').map(part => part.text).join('');
    const personality = state.configuration.personalities.find(p => p.id === attempt.personality);
    assert.ok(session.some(m => m.role === 'system' && JSON.stringify(m).includes(personality.personalityPrompts.instructions)));
    assert.equal(text, subagentFirstPrompt(state.tasks[index].assignment,
      personality.resolvedPrompts.firstPrompt, {
        request: scenario.prompt,
        plan: withPlan ? scenario.responses[0].arguments.markdown : '',
        handoverTemplate: personality.resolvedPrompts.handover,
      }));
  }
  assert.equal(saved.documents.filter(d => d.kind === 'html').length, 4);
  const view = workflowPresentation(saved);
  assert.equal(view.runs[0].tasks.length, 7);
  assert.equal(view.operations.outcomes.decided, 3);
  assert.equal(view.runs[0].plan === undefined, !withPlan);
  if (!withPlan) {
    const interruptedRoot = join(storage, 'second-worker-error');
    await mkdir(interruptedRoot);
    await assert.rejects(runOnce({ ...options, storage: interruptedRoot, scenario: { ...scenario,
      responses: [...workerSteps.slice(0, 5), { agent: 'tester', error: 'Second worker failed' }],
    } }), /Milestone incomplete/);
    const interrupted = (await loadProduction(new Store(interruptedRoot))).runs[0].checkpoints.at(-1);
    assert.equal(interrupted.phase, 'recovery-required');
    assert.equal(interrupted.tasks[0].attempts[0].status, 'completed');
    assert.equal(interrupted.tasks[0].attempts[0].export.state, 'saved');
    assert.equal(interrupted.tasks[1].attempts[0].status, 'interrupted');
  }
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
    const responses = legacyScenario.responses.flatMap(step => repair &&
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
            ? instructionsPrompt(text.instructions, text.handover)
            : orchestratorInstructionsPrompt(text.instructions, state.configuration.subagentIds)).trim()))));
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
    ['worker-ignores-reminder', [...legacyScenario.responses.slice(0, 2),
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
