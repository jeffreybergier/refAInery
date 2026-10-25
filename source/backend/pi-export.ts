import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

export const SCRIPT_FREE_DOCUMENT_POLICY = "sandbox; default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

// Compatibility with the first milestone's published exports. Remove this exact
// injected fallback only in the HTTP representation; never rewrite saved history.
const legacyPrefix = '<section style="padding:2rem"><h1>Saved Pi session</h1><p>refAInery static active-branch transcript. The original Pi viewer is retained below, but scripts are disabled on this server.</p><pre style="white-space:pre-wrap;overflow-wrap:anywhere">';
const legacyEnd = '</pre></section>';
const hash = (source: string) => `'sha256-${createHash("sha256").update(source).digest("base64")}'`;
let profile: { beforeCSS: string; beforeData: string; afterData: string; policy: string } | undefined;

function trustedProfile() {
  if (profile) return profile;
  // Use ONLY installed, pinned SDK code, never scripts taken from an export or
  // agent content. Upgrading Pi requires rerunning the real-viewer browser tests.
  const directory = new URL("./core/export-html/", import.meta.resolve("@earendil-works/pi-coding-agent"));
  const read = (path: string) => readFileSync(new URL(path, directory), "utf8");
  const shell = read("template.html")
    .replace("{{JS}}", read("template.js"))
    .replace("{{MARKED_JS}}", read("vendor/marked.min.js"))
    .replace("{{MARKED_CJK_FRIENDLY_JS}}", read("vendor/marked-cjk-friendly.min.js"))
    .replace("{{HIGHLIGHT_JS}}", read("vendor/highlight.min.js"));
  const [beforeCSS, rest, extraCSS] = shell.split("{{CSS}}");
  const [beforeData, afterData, extraData] = (rest ?? "").split("{{SESSION_DATA}}");
  const scripts = [...shell.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => hash(m[1]));
  if (!beforeCSS || !beforeData || !afterData || extraCSS !== undefined || extraData !== undefined || scripts.length !== 4) {
    throw new Error("Unsupported pinned Pi export template");
  }
  // Pi 1.4.0 also emits these three fixed inline handlers. No arbitrary inline
  // script, eval, same-origin privilege, network access, frames, or popups.
  const handlers = [
    "if(window.getSelection().toString())return;this.classList.toggle('expanded')",
    "if(window.getSelection().toString())return;this.classList.toggle('params-expanded')",
    "downloadSessionJson()",
  ].map(hash);
  profile = { beforeCSS, beforeData, afterData,
    policy: "sandbox allow-scripts allow-downloads; default-src 'none'; " +
      `script-src ${scripts.join(" ")}; script-src-attr 'unsafe-hashes' ${handlers.join(" ")}; ` +
      "style-src 'unsafe-inline'; img-src data:; connect-src 'none'; " +
      "base-uri 'none'; frame-ancestors 'none'; form-action 'none'" };
  return profile;
}

/** Recognize the pinned native export shell, with only CSS and base64 JSON data
 * varying. Unrecognized HTML never receives executable permissions. */
export function piExportDocument(saved: string): { content: string; policy: string } | null {
  if (!saved.includes('<script id="session-data" type="application/json">')) return null;
  let content = saved;
  const legacyStart = content.indexOf("<body>" + legacyPrefix);
  if (legacyStart >= 0) {
    const end = content.indexOf(legacyEnd, legacyStart);
    if (end < 0) return null;
    content = content.slice(0, legacyStart) + "<body>" + content.slice(end + legacyEnd.length);
  }
  const trusted = trustedProfile();
  if (!content.startsWith(trusted.beforeCSS) || !content.endsWith(trusted.afterData)) return null;
  const cssEnd = content.indexOf(trusted.beforeData, trusted.beforeCSS.length);
  if (cssEnd < 0 || content.slice(trusted.beforeCSS.length, cssEnd).includes("<")) return null;
  const data = content.slice(cssEnd + trusted.beforeData.length, -trusted.afterData.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(data, "base64").toString("utf8"));
    if (!decoded.header || !Array.isArray(decoded.entries)) return null;
  } catch { return null; }
  return { content, policy: trusted.policy };
}
