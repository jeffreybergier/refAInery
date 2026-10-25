import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ToolCall } from "@earendil-works/pi-ai";
import type { FauxProviderHandle } from "@earendil-works/pi-ai/providers/faux";
import { readJSON } from "./storage.ts";

export interface ScenarioStep {
  agent: "orchestrator" | "worker";
  text?: string;
  tool?: string;
  arguments?: ToolCall["arguments"];
  error?: string;
}
export interface Scenario { prompt: string; responses: ScenarioStep[]; }

export async function loadScenario(root: string, name: string): Promise<Scenario> {
  const scenario = await readJSON<Scenario>(`${root}/scenarios/${name}.json`);
  if (!scenario.prompt || !Array.isArray(scenario.responses) || !scenario.responses.length) {
    throw new Error("Invalid scenario");
  }
  for (const step of scenario.responses) {
    if (!["orchestrator", "worker"].includes(step.agent) || (!step.text && !step.tool && !step.error)) {
      throw new Error("Invalid scenario response");
    }
  }
  return scenario;
}

/** One global script follows the sequential orchestrator/worker/review lifecycle. */
export class ScriptedResponses {
  private next = 0;
  agent = "";
  readonly scenario: Scenario;
  constructor(scenario: Scenario) { this.scenario = scenario; }
  bind(faux: FauxProviderHandle) {
    faux.setResponses(this.scenario.responses.map(() => (context) => {
      const step = this.scenario.responses[this.next++];
      if (!step || step.agent !== this.agent) throw new Error("Unexpected scripted agent turn");
      const last = context.messages.at(-1);
      if (last?.role === "toolResult" && last.isError) {
        throw new Error(`Scripted tool ${last.toolName} failed: ${JSON.stringify(last.content)}`);
      }
      const content = [];
      if (step.text) content.push(fauxText(step.text));
      if (step.tool) content.push(fauxToolCall(step.tool, step.arguments ?? {}, { id: `script-${this.next}` }));
      return fauxAssistantMessage(content, {
        stopReason: step.error ? "error" : step.tool ? "toolUse" : "stop",
        ...(step.error ? { errorMessage: step.error } : {}),
      });
    }));
  }
  assertComplete() {
    if (this.next !== this.scenario.responses.length) throw new Error("Unused scripted responses");
  }
}
