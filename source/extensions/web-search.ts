import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Provider-native tool mapping adapted from the operator's Pi extension.
 * This does not register local Pi tools. The host must validate capabilities
 * before creating a session and explicitly install a session-scoped factory.
 */
type ModelTransport = { provider: string; api: string };
type ServerTool = { type: string };

const nativeTypes = new Set([
  "openrouter:web_search", "openrouter:web_fetch", "web_search",
]);

function resolveTools(
  availableTools: readonly string[], model: ModelTransport,
): ServerTool[] {
  const requested = availableTools.filter(
    (name) => name === "web_search" || name === "web_fetch",
  );
  return requested.map((name) => {
    if (model.provider === "openrouter") {
      return { type: `openrouter:${name}` };
    }
    if (model.provider === "openai" && model.api === "openai-responses" &&
        name === "web_search") {
      return { type: "web_search" };
    }
    throw new Error(`Unsupported web capability: ${name} for selected transport`);
  });
}

/** Create one extension per session from its frozen, validated allowlist.
 * Construction rejects unsupported web capabilities before a model call.
 * The host must prohibit provider/transport changes and unrelated extensions
 * that could re-enable tools after this hook. This is not a security sandbox.
 */
export function createWebSearchExtension(
  availableTools: readonly string[], model: ModelTransport,
): (pi: ExtensionAPI) => void {
  if (new Set(availableTools).size !== availableTools.length) {
    throw new Error("Duplicate availableTools entries");
  }
  const approved = resolveTools([...availableTools], model);
  const provider = model.provider;
  const api = model.api;

  return (pi) => {
    pi.on("before_provider_request", (event, ctx) => {
      if (typeof event.payload !== "object" || event.payload === null ||
          Array.isArray(event.payload)) return;

      const payload = event.payload as Record<string, unknown>;
      if (payload.tools !== undefined && !Array.isArray(payload.tools)) return;
      const existing = (payload.tools ?? []) as unknown[];
      // Unexpected model changes never gain this extension's web capabilities.
      const additions = ctx.model?.provider === provider && ctx.model.api === api
        ? approved : [];
      const allowedTypes = new Set(additions.map((tool) => tool.type));
      const seen = new Set<string>();
      const tools = existing.filter((tool) => {
        if (typeof tool !== "object" || tool === null) return true;
        const type = (tool as { type?: unknown }).type;
        if (typeof type !== "string" || !nativeTypes.has(type)) return true;
        if (!allowedTypes.has(type) || seen.has(type)) return false;
        seen.add(type);
        return true;
      });
      for (const tool of additions) {
        if (!seen.has(tool.type)) tools.push({ ...tool });
      }
      if (tools.length === existing.length &&
          tools.every((tool, index) => tool === existing[index])) return;
      return { ...payload, tools };
    });
  };
}

/** Direct file loading grants no web capabilities. The backend must use the
 * named factory with the frozen personality allowlist and selected transport.
 */
export default function webSearchDisabledByDefault(pi: ExtensionAPI): void {
  createWebSearchExtension([], { provider: "", api: "" })(pi);
}
