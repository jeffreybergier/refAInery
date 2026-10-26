import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Type } from '@earendil-works/pi-ai';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { loadConfiguration } from '../source/backend/config.ts';
import { createWorkflowExtension } from '../source/extensions/workflow.ts';
import { Store, now } from '../source/backend/storage.ts';
import { Workflow, enqueue } from '../source/backend/workflow.ts';
import { validateCheckpoint } from '../source/backend/validation.ts';
import { loadScenario } from '../source/backend/scenario.ts';

const ids = ['implementer', 'tester'];
const selection = { schemaVersion: 1, allowed: ids };
const overlay = id => ({ schemaVersion: 1, id, name: id, role: 'subagent',
  prompts: { instructions: `${id} instructions`, firstPrompt: `${id} task guidance`,
    firstReply: `${id} seed`, finalAnswer: `${id} reminder` },
  availableTools: id === 'tester' ? ['read', 'bash', 'finish_task'] : ['read', 'write', 'edit', 'bash', 'finish_task'],
});
const json = (path, value) => writeFile(path, JSON.stringify(value));
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'refainery-subagents-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'agents'));
  await json(join(root, 'subagents.json'), selection);
  for (const id of ids) await json(join(root, 'agents', `${id}.json`), overlay(id));
  return root;
}
async function workflow(root) {
  const config = await loadConfiguration(root), store = new Store(root);
  const flow = new Workflow(store, await enqueue(store, 'Implement and verify'), {
    ...config, id: 'config-test', models: [{ id: 'default', provider: 'faux', modelId: 'test', contextWindow: 250000 }],
    orchestratorModel: 'default',
  });
  flow.state.orchestrator.sessionId = 'session-orchestrator';
  await flow.beginTurn();
  return flow;
}
const assignment = personality => ({ personality, model: 'default', title: 'Task', assignment: 'Do the task', rationale: 'Next step' });

test('explicit selection loads exactly the listed personalities with independent prompts and tools', async t => {
  const root = await setup(t);
  // Unlisted files cannot add choices, even if they are malformed.
  await writeFile(join(root, 'agents/worker.json'), '{');
  await json(join(root, 'agents/extra.json'), overlay('extra'));
  const config = await loadConfiguration(root);
  assert.deepEqual(config.subagentIds, ids);
  assert.deepEqual(config.personalities.map(p => p.id), ['orchestrator', ...ids]);
  for (const id of ids) {
    const p = config.personalities.find(p => p.id === id);
    for (const [slot, value] of Object.entries(overlay(id).prompts)) {
      assert.ok(p.resolvedPrompts[slot].includes(value));
      assert.ok(!p.resolvedPrompts[slot].includes(`${id === 'tester' ? 'implementer' : 'tester'} `));
    }
    assert.deepEqual(p.availableTools, overlay(id).availableTools);
    assert.ok(p.instructions.includes(`${id} instructions`));
  }
});

test('invalid manifests and missing or mismatched selected personalities fail closed', async t => {
  const root = await setup(t), path = join(root, 'subagents.json');
  for (const invalid of [null, {}, { ...selection, extra: true }, { ...selection, schemaVersion: 2 },
    ...[[], ['tester', 'tester'], ['orchestrator'], ['../tester'], ['tester\n'], [1], 'tester'].map(allowed => ({ ...selection, allowed }))]) {
    await json(path, invalid);
    await assert.rejects(loadConfiguration(root), /Invalid subagent selection/);
  }
  await writeFile(path, '{');
  await assert.rejects(loadConfiguration(root), SyntaxError);
  await json(path, selection);
  for (const invalid of [{ ...overlay('tester'), id: 'other' }, { ...overlay('tester'), role: 'orchestrator' },
    { ...overlay('tester'), availableTools: ['spawn_subagent', 'finish_task'] }]) {
    await json(join(root, 'agents/tester.json'), invalid);
    await assert.rejects(loadConfiguration(root), /Invalid personality|Unauthorized tool/);
  }
  await rm(join(root, 'agents/tester.json'));
  await assert.rejects(loadConfiguration(root), /Missing selected subagent: tester/);
  await rm(path);
  await symlink(join(root, 'missing'), path);
  await assert.rejects(loadConfiguration(root), /ENOENT/);
  await rm(path);
  const outside = await setup(t);
  await symlink(join(outside, 'subagents.json'), path);
  await assert.rejects(loadConfiguration(root), /location/);
});

test('real tool schema and backend both reject every choice outside the frozen selection', async t => {
  const root = await setup(t), flow = await workflow(root), tools = [];
  createWorkflowExtension(Type, ['spawn_subagent'], async () => ({}), flow.state.configuration.subagentIds)({ registerTool: tool => tools.push(tool) });
  const validate = new Ajv2020({ strict: true }).compile(tools[0].parameters);
  for (const id of ids) assert.equal(validate(assignment(id)), true);
  for (const id of ['worker', 'orchestrator', 'extra', 'Tester', '', '../tester', null]) {
    assert.equal(validate(assignment(id)), false);
    await assert.rejects(flow.action('orchestrator', 'session-orchestrator', `bad-${id}`, 'spawn_subagent', assignment(id)), /outside frozen allowlist/);
  }
  assert.equal(flow.state.tasks.length, 0);
  // Disk edits affect future runs, never choices in an active run.
  await json(join(root, 'subagents.json'), { schemaVersion: 1, allowed: ['extra'] });
  await json(join(root, 'agents/extra.json'), overlay('extra'));
  assert.deepEqual((await loadConfiguration(root)).subagentIds, ['extra']);
  await assert.rejects(flow.action('orchestrator', 'session-orchestrator', 'extra-again', 'spawn_subagent', assignment('extra')), /outside frozen allowlist/);
  await flow.action('orchestrator', 'session-orchestrator', 'valid', 'spawn_subagent', assignment('tester'));
  assert.equal(flow.state.tasks[0].personality, 'tester');
});

test('checkpoints enforce selected task and attempt identity and immutable selections', async t => {
  const flow = await workflow(await setup(t));
  await flow.action('orchestrator', 'session-orchestrator', 'valid', 'spawn_subagent', assignment('tester'));
  const state = structuredClone(flow.state);
  for (const mutate of [
    s => { s.tasks[0].personality = 'worker'; },
    s => { delete s.tasks[0].personality; },
    s => { delete s.configuration.subagentIds; },
    s => { s.configuration.subagentIds = ['implementer']; },
    s => { s.configuration.personalities.push(s.configuration.personalities[0]); },
  ]) {
    const invalid = structuredClone(state); mutate(invalid);
    assert.throws(() => validateCheckpoint(invalid), /allowlist/);
  }
  const changed = structuredClone(state);
  changed.number++;
  changed.tasks[0].personality = 'implementer';
  assert.throws(() => validateCheckpoint(changed, state), /Changed task personality/);
  state.tasks[0].attempts.push({ id: 'attempt-test', title: 'Task', number: 1, model: 'default', personality: 'implementer',
    sessionId: 'session-tester', sessionPath: 'sessions/tester.jsonl', status: 'running', startedAt: now(), endedAt: null,
    handover: null, export: { state: 'not-due', path: null, error: null }, stopReason: null,
    review: 'not-submitted', reviewedAt: null, retryReason: null, planRevision: null });
  assert.throws(() => validateCheckpoint(state), /Attempt personality differs/);
});

test('scenario loader accepts configured personality IDs, not malformed identities', async t => {
  const root = await setup(t);
  await mkdir(join(root, 'scenarios'));
  for (const agent of [...ids, 'orchestrator', 'worker', 'other-valid-id']) {
    await json(join(root, 'scenarios/test.json'), { prompt: 'Test', responses: [{ agent, text: 'Done' }] });
    assert.equal((await loadScenario(root, 'test')).responses[0].agent, agent);
  }
  for (const agent of ['', '../tester', 'tester\n', null, 12]) {
    await json(join(root, 'scenarios/test.json'), { prompt: 'Test', responses: [{ agent, text: 'Done' }] });
    await assert.rejects(loadScenario(root, 'test'), /Invalid scenario response/);
  }
});
