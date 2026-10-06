"""Set shared instructions for non-OpenAI models before Codex loads its catalog."""

import copy
import json
import os
import tempfile
from pathlib import Path

catalog_path = Path(__file__).resolve().parents[1] / "model-catalog.json"
catalog = json.loads(catalog_path.read_text())
models = {model["slug"]: model for model in catalog["models"]}
sol = models["gpt-6.1-sol"]
shared_messages = copy.deepcopy(sol["model_messages"])
_, instruction_body = shared_messages["instructions_template"].split(". ", 1)
shared_messages["instructions_template"] = "You are Codex, a coding agent. " + instruction_body
fields = (
    "model_messages",
    "include_apps_usage_instructions",
    "include_plugin_usage_instructions",
    "include_skills_usage_instructions",
)
changed = False
for slug, model in models.items():
    if slug.startswith(("gpt-", "codex-")):
        continue
    for field in fields:
        value = shared_messages if field == "model_messages" else sol[field]
        if model.get(field) != value:
            model[field] = value
            changed = True

if changed:
    with tempfile.NamedTemporaryFile(mode="w", dir=catalog_path.parent, delete=False) as file:
        json.dump(catalog, file, indent=2, ensure_ascii=False)
        file.write("\n")
    os.replace(file.name, catalog_path)
