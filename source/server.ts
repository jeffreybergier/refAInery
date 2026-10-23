import { createServer } from "node:http";

const host = "0.0.0.0";
const port = 8080;
const page = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>refAInery</title>
  </head>
  <body>
    <h1>Hello, world!</h1>
    <p>Welcome to refAInery.</p>
  </body>
</html>
`;

const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(page);
});

server.listen(port, host, () => {
  console.log(`refAInery listening at http://${host}:${port}`);
});
