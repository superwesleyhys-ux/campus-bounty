"""Focused OpenAPI 3.1 validation using the installed JSON Schema validator."""
import copy
import json
from pathlib import Path
import unittest

from jsonschema import Draft202012Validator, FormatChecker

SPEC = json.loads((Path(__file__).resolve().parents[1] / "docs/backend-openapi.json").read_text())
SCHEMA = {"$ref": "#/components/schemas/ConversationPage", "components": SPEC["components"]}
Draft202012Validator.check_schema(SCHEMA)
VALIDATOR = Draft202012Validator(SCHEMA, format_checker=FormatChecker())
ID = "9c38cd1d-ad75-4c8b-a4dd-33c531ed5e00"
CONTEXT = {
    "applicationId": ID, "applicationState": "applied", "taskStatus": "open",
    "canSend": True, "sendUnavailableReason": None, "agreementId": None,
}


def page(scope):
    result = {
        "scope": {"type": scope, "id": ID}, "participants": [],
        "participantCount": 0, "participantLimit": 100, "nextParticipantCursor": None,
        "items": [], "nextCursor": None, "limit": 30,
    }
    if scope == "application":
        result["applicationContext"] = copy.deepcopy(CONTEXT)
    return result


class ConversationSchema(unittest.TestCase):
    def test_three_valid_scopes(self):
        for scope in ["application", "agreement", "order"]:
            with self.subTest(scope=scope):
                VALIDATOR.validate(page(scope))

    def test_scope_conditional_presence(self):
        missing = page("application")
        del missing["applicationContext"]
        invalid = [missing]
        for scope in ["agreement", "order"]:
            invalid.append({**page(scope), "applicationContext": CONTEXT})
        for shape in invalid:
            with self.subTest(scope=shape["scope"]["type"]):
                self.assertFalse(VALIDATOR.is_valid(shape))

    def test_all_six_context_fields_and_no_extras(self):
        self.assertEqual(len(CONTEXT), 6)
        for field in CONTEXT:
            shape = page("application")
            del shape["applicationContext"][field]
            with self.subTest(missing=field):
                self.assertFalse(VALIDATOR.is_valid(shape))
        for location in ["page", "scope", "applicationContext"]:
            shape = page("application")
            (shape if location == "page" else shape[location])["extra"] = True
            with self.subTest(extra=location):
                self.assertFalse(VALIDATOR.is_valid(shape))

    def test_preserved_bounds_and_types(self):
        participant = {"id": ID, "displayName": "Synthetic", "role": "applicant"}
        message = {"id": ID, "body": "Synthetic", "createdAt": "2026-01-01T00:00:00.000000Z", "author": participant}
        for field, value in [
            ("limit", 0), ("limit", 51), ("limit", 1.5),
            ("participantLimit", 99), ("participantCount", -1),
            ("participants", [participant] * 101), ("items", [message] * 51),
            ("scope", {"type": "other", "id": ID}), ("applicationContext", None),
        ]:
            with self.subTest(field=field, value=str(value)[:35]):
                self.assertFalse(VALIDATOR.is_valid({**page("application"), field: value}))
        edge = {**page("application"), "limit": 50, "participants": [participant] * 100, "items": [message] * 50}
        VALIDATOR.validate(edge)


if __name__ == "__main__":
    unittest.main(verbosity=2)
