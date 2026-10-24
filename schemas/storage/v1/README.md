# Storage v1: work request

`request.schema.json` defines the first production storage record. The fictional
example is `examples/storage/v1/request.json`, relative to the application root.
It is not production data or part of the dashboard's presentation fixtures.

A request records intake only:

| Field | Contract |
| --- | --- |
| `schemaVersion` | Integer `1` |
| `id` | Stable application-assigned identity, unique within storage |
| `prompt` | Original prompt, with at least one non-whitespace character |
| `receivedAt` | Application-recorded UTC receipt time, ending in `Z` |
| `source` | `manual`, the only initially supported source |

All five fields are required; unknown fields are rejected. IDs are 1–128 ASCII
letters, digits, underscores, or hyphens, beginning with a letter or digit.
This allows several ID-generation strategies without allowing path separators.

Use a JSON Schema Draft 2020-12 validator with `date-time` format assertions
explicitly enabled. The timestamp pattern enforces UTC spelling; format
validation checks the date/time itself. Schema validation does not enforce ID
uniqueness, record immutability, or the absence of secrets in free-form text;
those remain application responsibilities.

Once accepted, the request remains unchanged. Queue position, execution status,
run identity, provider/model selection, and results do not belong in this record.
Their schemas and the durable intake file layout are not defined by this slice.
No production writer or runtime validator is implemented here.
