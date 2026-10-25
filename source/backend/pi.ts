import { mkdir, readFile, open } from "node:fs/promises";
import { relative, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { Type, InMemoryCredentialStore, InMemoryModelsStore, type ImageContent } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { AgentSession, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Store, now, identity, publish, syncDirectory } from "./storage.ts";
import type { Registry } from "./registry.ts";
import type { Personality } from "./config.ts";
import type { Workflow } from "./workflow.ts";
import type { Sandbox } from "./sandbox.ts";
import { piExportDocument } from "./pi-export.ts";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { ScriptedResponses } from "./scenario.ts";
import { subagentText } from "../agents/subagent.ts";
import { orchestratorText } from "../agents/orchestrator.ts";
import { sharedText, resolveAgentText } from "../agents/shared.ts";

type Raw = Record<string, unknown>;
export interface Inference {
  schemaVersion: 1; id: string; runId: string; sessionId: string; personalityId: string;
  revision: number; startedAt: string; endedAt: string | null; status: string;
  provider: string; requestedModel: string; actualModel: string | null;
  actualModelSource: string | null; providerResponseId: string | null;
  registrySnapshotId: string | null; registryFreshness: string;
  providerUsage: unknown; reportedCost: unknown; normalizedUsage: unknown;
}
export function observeProvider(record: Inference, event: unknown) {
  if (!event || typeof event !== "object") return;
  const raw = event as Raw;
  const data = raw.response && typeof raw.response === "object" ? raw.response as Raw : raw;
  if (typeof data.model === "string" && data.model) {
    record.actualModel = data.model; record.actualModelSource = "provider-stream.model";
  }
  if (typeof data.id === "string") record.providerResponseId = data.id;
  if (data.usage && typeof data.usage === "object") {
    const u = data.usage as Raw;
    const allowed: Raw = {};
    for (const key of ["prompt_tokens", "completion_tokens", "total_tokens", "input_tokens", "output_tokens", "cost"]) {
      if (typeof u[key] === "number" && Number.isFinite(u[key]) && (u[key] as number) >= 0) allowed[key] = u[key];
    }
    record.providerUsage = allowed;
    if (typeof allowed.cost === "number") record.reportedCost = { amount: String(allowed.cost), currency: "USD", source: "provider-stream.usage.cost" };
  }
}

export class PiAdapter {
  private runtime!: ModelRuntime;
  private calls = 0;
  private fatal = false;
  readonly store: Store;
  readonly workflow: Workflow;
  readonly registry: Registry;
  readonly selected: string;
  private apiKey: string;
  readonly sandbox: Sandbox;
  readonly maxCalls: number;
  readonly scripted?: ScriptedResponses;
  readonly handbackAtTokens: number;
  constructor(store: Store, workflow: Workflow, registry: Registry,
    selected: string, apiKey: string, sandbox: Sandbox,
    maxCalls = 12, handbackAtTokens = 217232,
    scripted?: ScriptedResponses) {
    this.scripted = scripted;
    this.store = store; this.workflow = workflow; this.registry = registry;
    this.selected = selected; this.apiKey = apiKey; this.sandbox = sandbox;
    this.maxCalls = maxCalls; this.handbackAtTokens = handbackAtTokens;
  }
  async initialize() {
    const catalog = this.registry.current;
    const entry = catalog?.models.find((m) => m.id === this.selected);
    if (!entry || entry.context_length < 250000 || !entry.supported_parameters?.includes("tools")) {
      throw new Error("Selected model lacks verified catalog capacity/tools");
    }
    this.runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(),
      modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
    if (this.scripted) {
      const faux = fauxProvider({ provider: "faux", api: "refainery-scripted",
        models: [{ id: this.selected, contextWindow: 250000, maxTokens: 2048 }],
        tokenSize: { min: 4, max: 4 } });
      this.scripted.bind(faux);
      this.runtime.registerNativeProvider(faux.provider);
      return;
    }
    const price = (key: string) => {
      const n = Number(entry.pricing[key]);
      return Number.isFinite(n) && n >= 0 ? n * 1000000 : 0;
    };
    this.runtime.registerProvider("openrouter", {
      api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1", models: [{
        id: this.selected, name: this.selected, api: "openai-completions", reasoning: true,
        input: ["text"], contextWindow: 250000, maxTokens: 2048,
        cost: { input: price("prompt"), output: price("completion"), cacheRead: price("input_cache_read"), cacheWrite: price("input_cache_write") },
      }],
    });
    await this.runtime.setRuntimeApiKey("openrouter", this.apiKey);
    this.apiKey = "";
  }
  async create(personality: Personality) {
    const text = this.workflow.state.configuration.agentText?.[personality.role]
      ?? resolveAgentText(personality.role === "orchestrator" ? orchestratorText : subagentText);
    const firstReply = text.firstReply;
    const finalAnswer = text.finalAnswer;
    const contextHandbackPrompt = this.workflow.state.configuration.agentText?.subagent.contextHandback
      ?? subagentText.contextHandback;
    const runRoot = this.store.path(this.workflow.prefix);
    const agentDir = this.store.path(this.workflow.prefix, "pi-private", personality.id);
    await mkdir(agentDir, { recursive: true, mode: 0o700 });
    const manager = SessionManager.create(this.sandbox.workspace, this.store.path(this.workflow.prefix, "sessions"));
    const sessionId = manager.getSessionId();
    const path = relative(runRoot, manager.getSessionFile()!);
    const web = await import(pathToFileURL(this.store.path(this.workflow.prefix, "config/extensions/web-search.ts")).href);
    const workflow = await import(pathToFileURL(this.store.path(this.workflow.prefix, "config/extensions/workflow.ts")).href);
    const model = this.runtime.getModel(this.scripted ? "faux" : "openrouter", this.selected);
    if (!model) throw new Error("Configured model unavailable");
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false }, cacheWarming: "off", defaultTools: [],
      retry: { enabled: false, provider: { maxRetries: 0, timeoutMs: 90000 } },
      enableInstallTelemetry: false, enableAnalytics: false,
    });
    let contextHandback = false;
    const resourceLoader = new DefaultResourceLoader({
      cwd: this.sandbox.workspace, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: personality.instructions,
      extensionFactories: [
        web.createWebSearchExtension(personality.availableTools, model),
        workflow.createWorkflowExtension(Type, personality.availableTools,
          async (callId: string, name: string, args: Raw) => {
            if (this.fatal) throw new Error("Run halted");
            if (contextHandback && name === "finish_task" && args.stopReason !== "context-limit") throw new Error(sharedText.contextStopReasonRequired);
            return this.workflow.action(personality.role, sessionId, callId, name, args);
          }),
        (pi: ExtensionAPI) => { pi.on("session_before_compact", () => ({ cancel: true })); },
      ],
    });
    await resourceLoader.reload();
    if (resourceLoader.getExtensions().errors.length) throw new Error("Extension loading failed");
    const expected = personality.availableTools.filter((id) => !["web_search", "web_fetch"].includes(id)).sort();
    const { session } = await createAgentSession({ cwd: this.sandbox.workspace, agentDir, model,
      modelRuntime: this.runtime, sessionManager: manager, settingsManager, resourceLoader,
      thinkingLevel: "off", tools: expected, // SDK 1.4's heterogeneous customTools parameter loses schema generics.
      customTools: this.sandbox.tools(personality.availableTools) as unknown as ToolDefinition[] });
    await session.bindExtensions({});
    session.agent.toolExecution = "sequential";
    // AgentSession prepares the system/user messages and retains its lifecycle.
    // Add the seed to that first message batch so Pi persists it in order and
    // sends it as assistant history, not as a custom (user-role) message.
    const agentPrompt = session.agent.prompt.bind(session.agent);
    let seedPending = !!firstReply.trim();
    session.agent.prompt = async (input, images?: ImageContent[]) => {
      if (seedPending && Array.isArray(input) && input.some((message) => message.role === "user")) {
        seedPending = false;
        await agentPrompt([...input, {
          role: "assistant", content: [{ type: "text", text: firstReply }],
          api: model.api, provider: "refainery", model: "firstReply",
          stopReason: "stop", timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        }]);
      } else if (typeof input === "string") {
        await agentPrompt(input, images);
      } else {
        await agentPrompt(input);
      }
    };
    // Explicit tool selection overrides extension activation defaults in Pi.
    // Verify registration first: Pi otherwise silently ignores unknown names.
    const registered = session.getAllTools().map((tool) => tool.name);
    if (expected.some((name) => !registered.includes(name))) {
      session.dispose(); throw new Error("Expected workflow tool not registered");
    }
    session.setActiveToolsByName(expected);
    if (JSON.stringify(session.getActiveToolNames().sort()) !== JSON.stringify(expected)) {
      session.dispose(); throw new Error("Unexpected active tool set");
    }
    const oldBefore = session.agent.beforeToolCall;
    session.agent.beforeToolCall = async (context, signal) => {
      if (this.fatal || signal?.aborted) return { block: true, reason: "Run halted" };
      const terminal = ["spawn_subagent", "finish_task", "finish_request"];
      const calls = context.assistantMessage.content.filter((c) => c.type === "toolCall");
      if (calls.some((c) => terminal.includes(c.name)) && calls.length !== 1) {
        return { block: true, reason: sharedText.terminalCallRequired };
      }
      if (contextHandback && context.toolCall.name !== "finish_task") return { block: true, reason: sharedText.handbackRequired };
      return oldBefore?.(context, signal);
    };
    let current: Inference | null = null;
    const oldRaw = session.agent.onProviderStreamEvent;
    session.agent.onProviderStreamEvent = async (event, metadata) => {
      if (current) observeProvider(current, event);
      await oldRaw?.(event, metadata);
    };
    const original = session.agent.streamFunction;
    session.agent.streamFunction = async (requested, context, options) => {
      if (this.fatal || this.calls >= this.maxCalls) throw new Error("Inference budget exhausted or run halted");
      const estimate = Math.max(session.getContextUsage()?.tokens ?? 0, Math.ceil(JSON.stringify(context).length / 3));
      if (estimate >= this.handbackAtTokens && !contextHandback) {
        if (personality.role !== "subagent") throw new Error("Orchestrator context guard reached");
        contextHandback = true;
        throw new Error("Context handback required");
      }
      if (estimate >= 245000) throw new Error("Insufficient context reserve for handback");
      this.calls++;
      current = { schemaVersion: 1, id: identity("call"), runId: this.workflow.state.runId,
        sessionId, personalityId: personality.id, revision: 1, startedAt: now(), endedAt: null,
        status: "started", provider: requested.provider, requestedModel: requested.id,
        actualModel: null, actualModelSource: null, providerResponseId: null,
        ...this.registry.reference(), providerUsage: null, reportedCost: null, normalizedUsage: null };
      try { await this.store.save(`${this.workflow.prefix}/inferences/${current.id}/000001.json`, current); }
      catch { this.fatal = true; throw new Error("Cannot persist inference intent"); }
      return original(requested, context, options);
    };
    // Agent listeners are awaited before executing tools; persistence failure
    // blocks state-changing calls and all subsequent model dispatches.
    session.agent.subscribe(async (event) => {
      if (event.type !== "message_end" || event.message.role !== "assistant" || !current) return;
      const record = current; current = null;
      record.revision = 2; record.endedAt = now(); record.status = event.message.stopReason;
      record.normalizedUsage = { input: event.message.usage.input, output: event.message.usage.output,
        cacheRead: event.message.usage.cacheRead, cacheWrite: event.message.usage.cacheWrite,
        source: this.scripted ? "faux-estimate" : "pi-normalized", completeness: "not-independently-verified" };
      try { await this.store.save(`${this.workflow.prefix}/inferences/${record.id}/000002.json`, record); }
      catch { this.fatal = true; session.agent.abort(); throw new Error("Cannot persist inference result"); }
    });
    return { session, sessionId, path, personality,
      prompt: async (prompt: string) => {
        if (this.scripted) this.scripted.agent = personality.id;
        const timer = setTimeout(() => { this.fatal = true; session.agent.abort(); }, 180000);
        try {
          await session.prompt(prompt);
          if (contextHandback && personality.role === "subagent" && this.workflow.state.phase === "executing" && !this.fatal) {
            session.setActiveToolsByName(["finish_task"]);
            await session.prompt(contextHandbackPrompt);
          } else if (!this.fatal && finalAnswer.trim()) {
            const last = session.messages.at(-1);
            const yielded = personality.role === "orchestrator"
              ? !!this.workflow.state.pendingAction
              : !!this.workflow.state.tasks.at(-1)?.attempts.at(-1)?.handover;
            if (!yielded && last?.role === "assistant" && last.stopReason === "stop" &&
                !last.errorMessage && !last.content.some((part) => part.type === "toolCall")) {
              // One reminder per externally prompted round, within the same
              // timer/inference budget. Never retry provider errors or tool calls.
              await session.prompt(finalAnswer);
            }
          }
          if (this.fatal) throw new Error("Run halted");
          const last = session.messages.filter((message) => message.role === "assistant").at(-1);
          if (last?.role === "assistant" && ["error", "aborted", "length"].includes(last.stopReason)) {
            throw new Error("Pi turn did not finish successfully", { cause: last.errorMessage });
          }
        } finally { clearTimeout(timer); }
      },
    };
  }
}

export async function exportSession(store: Store, prefix: string, session: AgentSession, name: string) {
  // Pi writes its export; only publish an immutable durable file after success.
  const temp = store.path(prefix, "pi-private", `${name}.html`);
  await session.exportToHtml(temp);
  const native = await readFile(temp, "utf8");
  if (piExportDocument(native)?.content !== native) throw new Error("Unsupported Pi export template");
  const path = `exports/${name}.html`;
  await publish(store.path(prefix, path), native);
  if (session.sessionFile) {
    const handle = await open(session.sessionFile, "r");
    try { await handle.sync(); } finally { await handle.close(); }
    await syncDirectory(dirname(session.sessionFile));
    await syncDirectory(dirname(dirname(session.sessionFile)));
  }
  return { state: "saved" as const, path, error: null };
}
