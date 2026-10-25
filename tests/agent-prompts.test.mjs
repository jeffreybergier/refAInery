import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai/providers/faux';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { loadConfiguration } from '../source/backend/config.ts';
import { PiAdapter, exportSession } from '../source/backend/pi.ts';
import { Store, names } from '../source/backend/storage.ts';
import { Workflow, enqueue } from '../source/backend/workflow.ts';

async function setup(t, role, text, responses, maxCalls = 12) {
  const root = await mkdtemp(join(tmpdir(), 'refainery-prompt-slots-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root), config = await loadConfiguration(root);
  Object.assign(config.agentText[role], text);
  const personality = config.personalities.find(p => p.role === role);
  if (role === 'subagent') personality.availableTools = ['finish_task'];
  const flow = new Workflow(store, await enqueue(store, 'Prompt test'), {
    ...config, id: 'config-test', models: [{ id: 'default', provider: 'faux', modelId: 'test', contextWindow: 250000 }],
    orchestratorModel: 'default',
  });
  for (const extension of config.extensions) {
    await store.document(`${flow.prefix}/config/extensions/${extension.name}.ts`, extension.code);
  }
  const workspace = store.path(flow.prefix, 'workspace');
  await mkdir(workspace, { recursive: true });
  const contexts = [];
  const scripted = {
    bind(faux) {
      faux.setResponses(responses.map(response => context => {
        contexts.push(structuredClone(context));
        return fauxAssistantMessage([fauxText(response.text ?? 'Model reply')], {
          stopReason: response.stopReason ?? 'stop',
          ...(response.errorMessage ? { errorMessage: response.errorMessage } : {}),
        });
      }));
    },
  };
  const registry = {
    current: { models: [{ id: 'test', context_length: 250000, supported_parameters: ['tools'] }] },
    reference: () => ({ registrySnapshotId: null, registryFreshness: 'fresh' }),
  };
  const adapter = new PiAdapter(store, flow, registry, 'test', '', { workspace, tools: () => [] }, maxCalls, 217232, scripted);
  await adapter.initialize();
  const agent = await adapter.create(personality);
  t.after(() => agent.session.dispose());
  return { agent, store, flow, contexts };
}
const plainText = message => typeof message.content === 'string'
  ? message.content : message.content.filter(part => part.type === 'text').map(part => part.text).join('');

for (const role of ['orchestrator', 'subagent']) {
  test(`${role}: firstReply is one persisted assistant seed before inference, not usage`, async t => {
    const seed = `Seeded ${role} reply`;
    const { agent, store, flow, contexts } = await setup(t, role, { firstReply: seed, finalAnswer: '\n' }, [{}, {}]);
    await agent.prompt('Initial task');
    assert.deepEqual(contexts[0].messages.filter(m => m.role !== 'system').map(m => [m.role, plainText(m)]), [
      ['user', 'Initial task'], ['assistant', seed],
    ]);
    await agent.prompt('Next round');
    assert.equal(contexts[1].messages.filter(m => m.role === 'assistant' && plainText(m) === seed).length, 1);
    const restored = SessionManager.open(agent.session.sessionFile).buildSessionContext().messages;
    const seeds = restored.filter(m => m.role === 'assistant' && plainText(m) === seed);
    assert.equal(seeds.length, 1);
    assert.equal(seeds[0].provider, 'refainery');
    assert.equal(seeds[0].model, 'firstReply');
    assert.equal(seeds[0].usage.totalTokens, 0);
    assert.equal((await names(store.path(flow.prefix, 'inferences'))).length, 2);
    const exported = await exportSession(store, flow.prefix, agent.session, role);
    assert.equal(exported.state, 'saved');
    const html = await readFile(store.path(flow.prefix, exported.path), 'utf8');
    const encoded = html.match(/<script id="session-data" type="application\/json">\s*([A-Za-z0-9+/=]+)\s*<\/script>/)[1];
    const exportedData = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    assert.equal(exportedData.entries.filter(entry => entry.type === 'message' &&
      entry.message.role === 'assistant' && plainText(entry.message) === seed).length, 1);
  });

  test(`${role}: finalAnswer follows a clean text-only stop, at most once per round`, async t => {
    const reminder = `Finish the ${role} round using its completion tool.`;
    const { agent, contexts } = await setup(t, role, { firstReply: '\n', finalAnswer: reminder }, [{}, {}]);
    await agent.prompt('Initial task');
    assert.equal(contexts.length, 2);
    assert.equal(contexts[0].messages.filter(m => m.role === 'assistant').length, 0);
    assert.equal(contexts[1].messages.at(-1).role, 'user');
    assert.equal(plainText(contexts[1].messages.at(-1)), reminder);
  });

  test(`${role}: empty finalAnswer disables the reminder`, async t => {
    const { agent, contexts } = await setup(t, role, { firstReply: '\n', finalAnswer: '\n' }, [{}]);
    await agent.prompt('Initial task');
    assert.equal(contexts.length, 1);
  });
}

for (const stopReason of ['error', 'aborted', 'length']) {
  test(`finalAnswer never retries ${stopReason}`, async t => {
    const { agent, contexts } = await setup(t, 'orchestrator', { firstReply: '\n', finalAnswer: 'Reminder' }, [
      { stopReason, errorMessage: 'Unsuccessful response' },
    ]);
    await assert.rejects(agent.prompt('Initial task'), /did not finish successfully/);
    assert.equal(contexts.length, 1);
  });
}

test('finalAnswer does not bypass the inference budget', async t => {
  const { agent, contexts } = await setup(t, 'orchestrator', { firstReply: '\n', finalAnswer: 'Reminder' }, [{}, {}], 1);
  await assert.rejects(agent.prompt('Initial task'), /did not finish successfully|budget/);
  assert.equal(contexts.length, 1);
});
