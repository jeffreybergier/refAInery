import { readFile } from "node:fs/promises";

interface RequestFixture {
  schemaVersion: 1;
  id: string;
  prompt: string;
  receivedAt: string;
  source: "manual";
}

/** Validate the bundled fictional intake collection, not production storage.
 * The array is a preview container; each element is a storage v1 request.
 * No queue membership, execution state, or receipt order is inferred.
 */
export function validateRequestFixtures(value: unknown): RequestFixture[] {
  if (!Array.isArray(value)) throw new Error("Expected request fixtures.");
  const ids = new Set<string>();
  const fields = ["schemaVersion", "id", "prompt", "receivedAt", "source"];
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
        Object.keys(item).length !== fields.length ||
        !fields.every((key) => Object.hasOwn(item, key)) ||
        item.schemaVersion !== 1 || item.source !== "manual" ||
        typeof item.id !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(item.id) ||
        typeof item.prompt !== "string" || !/\S/.test(item.prompt) ||
        typeof item.receivedAt !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(item.receivedAt)) {
      throw new Error("Invalid request fixture.");
    }
    // Calendar validation, including dates Date.parse would silently normalize.
    const date = new Date(item.receivedAt);
    if (!Number.isFinite(date.getTime()) ||
        date.toISOString().slice(0, 19) !== item.receivedAt.slice(0, 19) ||
        ids.has(item.id)) throw new Error("Invalid request time or duplicate ID.");
    ids.add(item.id);
    return { schemaVersion: 1, id: item.id, prompt: item.prompt,
      receivedAt: item.receivedAt, source: "manual" };
  });
}

export async function loadIntakePreview() {
  const value: unknown = JSON.parse(await readFile(
    new URL("./fixtures/requests-v1.json", import.meta.url), "utf8"));
  return { mode: "test", requests: validateRequestFixtures(value) };
}
