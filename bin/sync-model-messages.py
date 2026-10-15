"""Set Claude instructions for non-OpenAI models before Codex loads its catalog."""

import copy
import json
import os
import tempfile
from pathlib import Path

codex_root = Path(__file__).resolve().parents[1]
catalog_path = codex_root / "model-catalog.json"
catalog = json.loads(catalog_path.read_text())
models = {model["slug"]: model for model in catalog["models"]}
sol = models["gpt-6.1-sol"]
shared_messages = copy.deepcopy(sol["model_messages"])
shared_messages["instructions_template"] = (codex_root / "prompts/claude-instructions.md").read_text()
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
