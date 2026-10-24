#!/bin/bash
# One command to start the demo AND the live database viewer.
#   ./scripts/start_demo.sh                       # normal (uses projects/optislot.db)
#   OPTISLOT_DB=/tmp/demo.db ./scripts/start_demo.sh   # fresh database for the real demo
#
# Put your Gemini key in ~/.zshrc once (export GEMINI_API_KEY="...") so it is never typed or pasted again.
# Without a key everything still works: the English -> rule box uses the built-in offline parser.

cd "$(dirname "$0")/.." || exit 1
ROOT="$PWD"

# 1) free port 8000 (an older server may still be running)
lsof -ti:8000 | xargs kill 2>/dev/null

# 2) an old model name in the shell breaks the AI box; use the app's working default
unset GEMINI_MODEL

if [ -z "$GEMINI_API_KEY" ]; then
  echo "note: GEMINI_API_KEY is not set -> the AI rule box will use the offline parser"
fi

# 3) open the live database viewer in a NEW Terminal window (macOS)
DBENV=""
[ -n "$OPTISLOT_DB" ] && DBENV="OPTISLOT_DB='$OPTISLOT_DB' "
osascript -e "tell application \"Terminal\" to do script \"cd '$ROOT' && ${DBENV}python3 scripts/dbwatch.py\"" >/dev/null 2>&1 \
  || echo "could not open a second window; run in another terminal:  python3 scripts/dbwatch.py"

# 4) warm the CP-SAT solver right away (a fresh venv spends ~15-20 s compiling ortools on first import); `make demo` and the
#    app itself warm it too, so this only starts the work a few seconds earlier
(cd "$ROOT/backend" && uv run python -m app.warmup >/dev/null 2>&1 &)

# 5) start the app (build + serve on http://localhost:8000); the server log is this window
make demo
