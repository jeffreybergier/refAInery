import { rm } from "node:fs/promises";
import { environment, storageRoot } from "./environment.ts";

if (environment() !== "test") throw new Error("reset is a test action");
// Explicit operator action; does not touch checked-in fixtures or production.
for (const path of ["runs", "requests", "workspaces", "registry", ".writer-lock"]) {
  await rm(`${storageRoot}/${path}`, { recursive: true, force: true });
}
console.log("Generated test records removed. Fixtures retained.");
