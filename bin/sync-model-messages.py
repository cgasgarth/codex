"""Copy Sol's messages to Claude before Codex reads the model catalog."""

import json
import os
import tempfile
from pathlib import Path

catalog_path = Path(__file__).resolve().parents[1] / "model-catalog.json"
catalog = json.loads(catalog_path.read_text())
models = {model["slug"]: model for model in catalog["models"]}
sol = models["gpt-6.1-sol"]
fields = (
    "model_messages",
    "include_apps_usage_instructions",
    "include_plugin_usage_instructions",
    "include_skills_usage_instructions",
)
changed = False
for slug in ("claude-opus-5-5", "claude-fable-5-1"):
    model = models[slug]
    for field in fields:
        if model.get(field) != sol[field]:
            model[field] = sol[field]
            changed = True

if changed:
    with tempfile.NamedTemporaryFile(mode="w", dir=catalog_path.parent, delete=False) as file:
        json.dump(catalog, file, indent=2, ensure_ascii=False)
        file.write("\n")
    os.replace(file.name, catalog_path)
