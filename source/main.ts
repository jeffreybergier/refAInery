import { createAppServer } from "./server.ts";

const server = createAppServer();
server.listen(8080, "0.0.0.0", () => {
  console.log("refAInery listening on port 8080");
});
