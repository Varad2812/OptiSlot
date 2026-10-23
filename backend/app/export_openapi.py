"""Dump the OpenAPI schema to backend/openapi.json (input for `make types`)."""
import json
from pathlib import Path

from app.main import app

out = Path(__file__).resolve().parents[1] / "openapi.json"
out.write_text(json.dumps(app.openapi(), indent=1))
print(f"wrote {out}")
