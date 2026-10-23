"""Point the API at a throw-away SQLite database before app.main is imported."""
import os
import tempfile
from pathlib import Path

os.environ.setdefault("OPTISLOT_DB", str(Path(tempfile.mkdtemp(prefix="optislot-test-")) / "test.db"))
