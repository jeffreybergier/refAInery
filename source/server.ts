import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

// Explicit routes keep source, configuration, and credentials out of the web root.
const assets = new Map([
  ["/", ["./public/index.html", "text/html; charset=utf-8"]],
  ["/assets/refainery.css", ["./public/refainery.css", "text/css; charset=utf-8"]],
  ["/assets/bootstrap.min.css", [
    "../node_modules/bootstrap/dist/css/bootstrap.min.css", "text/css; charset=utf-8",
  ]],
  ["/assets/bootstrap.bundle.min.js", [
    "../node_modules/bootstrap/dist/js/bootstrap.bundle.min.js", "text/javascript; charset=utf-8",
  ]],
]);

export function createAppServer() {
  return createServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy",
      "default-src 'none'; style-src 'self'; script-src 'self'; " +
      "img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Cache-Control", "no-store");

    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" });
      response.end("Method not allowed\n");
      return;
    }

    // No user-supplied path is ever passed to the filesystem.
    const pathname = (request.url ?? "/").split("?")[0];
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
