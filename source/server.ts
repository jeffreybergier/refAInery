import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { loadPreview, readPreviewTranscript } from "./preview.ts";
import { loadWorkflowPreview, readWorkflowDocument } from "./workflow-preview.ts";
import type { PreviewDirectories } from "./preview.ts";

// Explicit routes keep source, configuration, and credentials out of the web root.
const assets = new Map([
  ["/v1", ["./public/intake.html", "text/html; charset=utf-8"]],
  ["/v2", ["./public/index.html", "text/html; charset=utf-8"]],
  ["/assets/intake.js", ["./public/intake.js", "text/javascript; charset=utf-8"]],
  ["/assets/workflow.js", ["./public/workflow.js", "text/javascript; charset=utf-8"]],
  ["/assets/refainery.css", ["./public/refainery.css", "text/css; charset=utf-8"]],
  ["/assets/preview.js", ["./public/preview.js", "text/javascript; charset=utf-8"]],
  ["/assets/floor.js", ["./public/floor.js", "text/javascript; charset=utf-8"]],
  ["/assets/bootstrap.min.css", [
    "../node_modules/bootstrap/dist/css/bootstrap.min.css", "text/css; charset=utf-8",
  ]],
  ["/assets/bootstrap.bundle.min.js", [
    "../node_modules/bootstrap/dist/js/bootstrap.bundle.min.js", "text/javascript; charset=utf-8",
  ]],
]);

export function createAppServer(preview?: PreviewDirectories) {
  return createServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy",
      "default-src 'none'; style-src 'self'; script-src 'self'; " +
      "img-src 'self' data:; connect-src 'self'; base-uri 'none'; " +
      "frame-ancestors 'none'; form-action 'none'");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Cache-Control", "no-store");

    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" });
      response.end("Method not allowed\n");
      return;
    }

    // No user-supplied path is ever passed to the filesystem.
    const pathname = (request.url ?? "/").split("?")[0];
    if (["/", "/v1/", "/v2/"].includes(pathname)) {
      response.writeHead(302, { Location: pathname === "/v2/" ? "/v2" : "/v1" });
      response.end();
      return;
    }
    if (pathname === "/api/preview" || pathname === "/api/v1/preview") {
      try {
        const data = !preview ? { mode: "production" } :
          pathname === "/api/v1/preview" ? await loadWorkflowPreview() : await loadPreview(preview);
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        response.end(request.method === "HEAD" ? undefined : JSON.stringify(data));
      } catch {
        response.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
        response.end(request.method === "HEAD" ? undefined : JSON.stringify({
          error: "Test fixtures unavailable or invalid. Check the test JSON files.",
        }));
      }
      return;
    }
    const transcript = /^\/preview\/transcripts\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,79})\.html$/.exec(pathname);
    const document = /^\/preview\/v1\/documents\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,127}\/(?:plans|handovers|exports)\/[a-zA-Z0-9_-]+\.(?:md|html))$/.exec(pathname);
    if (preview && (transcript || document)) {
      // Generated HTML is untrusted. Isolate its origin and prohibit all scripts,
      // forms, external resources, frames, and popups, even in future Pi exports.
      response.setHeader("Content-Security-Policy",
        "sandbox; default-src 'none'; style-src 'unsafe-inline'; " +
        "base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
      try {
        const record = document ? await readWorkflowDocument(document[1]) : null;
        const content = document ? record?.content : await readPreviewTranscript(preview, transcript![1]);
        if (content != null && (document || content.length > 0)) {
          response.writeHead(200, { "Content-Type": record?.kind === "markdown" ? "text/plain; charset=utf-8" : "text/html; charset=utf-8" });
          response.end(request.method === "HEAD" ? undefined : content);
        } else {
          response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          response.end(request.method === "HEAD" ? undefined : "Transcript not found\n");
        }
      } catch {
        response.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
        response.end(request.method === "HEAD" ? undefined : "Test transcript unavailable\n");
      }
      return;
    }
    const asset = assets.get(pathname);
    if (!asset) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(request.method === "HEAD" ? undefined : "Not found\n");
      return;
    }

    try {
      const content = await readFile(new URL(asset[0], import.meta.url));
      response.writeHead(200, {
        "Content-Type": asset[1],
        "Content-Length": content.length,
      });
      response.end(request.method === "HEAD" ? undefined : content);
    } catch {
      // Do not expose local paths or exception contents to the browser.
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(request.method === "HEAD" ? undefined : "Page unavailable\n");
    }
  });
}
