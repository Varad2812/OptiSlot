.PHONY: dev demo warm test types fixtures catalog profile backend frontend build

BACKEND := cd backend && uv run

dev: ## backend :8000 + Vite :5173 (proxy /api)
	@trap "kill 0" EXIT; \
	(cd backend && uv run uvicorn app.main:app --reload --port 8000) & \
	(cd frontend && npm run dev) & \
	wait

build:
	cd frontend && npm run build

warm: ## compile + load the CP-SAT solver now (a fresh venv spends ~15-20 s on its first import)
	$(BACKEND) python -m app.warmup

demo: ## one offline process: FastAPI serves frontend/dist at :8000 (the solver warms up while the frontend builds, and again in the app)
	@($(BACKEND) python -m app.warmup >/dev/null 2>&1 &)
	@$(MAKE) --no-print-directory build
	$(BACKEND) uvicorn app.main:app --port 8000

test:
	$(BACKEND) pytest

types: ## regenerate frontend/src/api/types.ts from the FastAPI OpenAPI schema
	$(BACKEND) python -m app.export_openapi
	cd frontend && npm run types

fixtures:
	$(BACKEND) python ../scripts/make_fixtures.py

catalog:
	$(BACKEND) python ../scripts/extract_catalog.py

profile:
	$(BACKEND) python ../scripts/profile_data.py
