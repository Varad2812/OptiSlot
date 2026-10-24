"""Point the API at a throw-away SQLite database before app.main is imported."""
import os
import tempfile
from pathlib import Path

os.environ.setdefault("OPTISLOT_DB", str(Path(tempfile.mkdtemp(prefix="optislot-test-")) / "test.db"))
os.environ.setdefault("OPTISLOT_WARMUP", "0")   # tests allocate the demo synchronously; test_warmup.py covers the thread itself
