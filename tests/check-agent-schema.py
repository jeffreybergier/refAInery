"""Optional JSON Schema contract checks; requires jsonschema (not runtime code).

Run with an isolated Python environment containing jsonschema==4.26.0.
Additional command-line paths are personality JSON files to validate.
"""

from copy import deepcopy
import json
from pathlib import Path
import sys
import unittest

from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = json.loads(
    (ROOT / "schemas/config/v1/agent.schema.json").read_text()
)
FILES = [Path(path) for path in sys.argv[1:]]
VALID = {
    "schemaVersion": 1,
    "id": "worker",
    "name": "Worker",
    "role": "subagent",
    "prompts": {"instructions": "Work carefully.\n\nReport what you checked."},
    "availableTools": ["read", "write", "edit", "bash"],
}


class AgentSchemaTests(unittest.TestCase):
    def setUp(self):
        self.validator = Draft202012Validator(SCHEMA)

    def test_schema_is_valid(self):
        Draft202012Validator.check_schema(SCHEMA)

    def test_both_roles_and_no_tools_are_valid(self):
        self.validator.validate(VALID)
        agent = deepcopy(VALID)
        agent.update(id="orchestrator", role="orchestrator", availableTools=[])
        self.validator.validate(agent)

    def test_overlay_fields_are_required(self):
        for field in SCHEMA["required"]:
            with self.subTest(field=field):
                agent = deepcopy(VALID)
                del agent[field]
                self.assertFalse(self.validator.is_valid(agent))

    def test_tools_and_prompts_are_optional(self):
        agent = deepcopy(VALID)
        del agent["availableTools"]
        del agent["prompts"]
        self.validator.validate(agent)
        self.validator.validate({**agent, "prompts": {}})

    def test_prompt_slots_and_role_authorization(self):
        for role in ["orchestrator", "subagent"]:
            fields = ["instructions", "firstPrompt", "firstReply", "finalAnswer"]
            if role == "orchestrator":
                fields.append("subagentReview")
            for field in fields:
                for value in ["", " \n\t", "Literal {{ OPTIONAL_PERSONALITY_ADDITION }}"]:
                    self.validator.validate({**VALID, "role": role,
                                             "prompts": {field: value}})
                for value in [None, 1, True, [], {}]:
                    self.assertFalse(self.validator.is_valid(
                        {**VALID, "role": role, "prompts": {field: value}}))
        self.assertFalse(self.validator.is_valid(
            {**VALID, "prompts": {"subagentReview": "Review"}}))
        for field in ["unknown", "firstPromt", "contextHandback", "handover"]:
            self.assertFalse(self.validator.is_valid(
                {**VALID, "prompts": {field: "Not customizable"}}))

    def test_invalid_values(self):
        cases = {
            "schemaVersion": [0, 2, "1", True],
            "id": ["", "../worker", "worker\n", " worker", "a" * 129],
            "name": ["", " \n\t", None],
            "role": ["worker", "admin", "", None],
            "prompts": [None, "text", [], 1],
            "availableTools": [None, "read", ["read", "read"], ["*"],
                               [""], ["../bash"], ["read\n"], [1]],
        }
        for field, values in cases.items():
            for value in values:
                with self.subTest(field=field, value=value):
                    agent = deepcopy(VALID)
                    agent[field] = value
                    self.assertFalse(self.validator.is_valid(agent))

    def test_unknown_fields_are_rejected(self):
        for field in ["instructions", "firstPrompt", "instructionsFile", "model", "actualModel", "apiKey"]:
            with self.subTest(field=field):
                self.assertFalse(self.validator.is_valid({**VALID, field: "x"}))

    def test_catalog_membership_is_not_structural_validation(self):
        agent = {**VALID, "availableTools": ["not-in-server-catalog"]}
        self.validator.validate(agent)

    def test_supplied_configuration_files(self):
        seen = set()
        for path in FILES:
            with self.subTest(path=str(path)):
                agent = json.loads(path.read_text())
                self.validator.validate(agent)
                self.assertEqual(path.stem, agent["id"])
                self.assertNotIn(agent["id"], seen)
                seen.add(agent["id"])


if __name__ == "__main__":
    unittest.main(argv=[sys.argv[0]])
