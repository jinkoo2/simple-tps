# Simple TPS

Planning notes for a simple cross-platform treatment planning system using
NiiVue for visualization and `.mha` files for working image data.

Start with [PROJECT_PLAN.md](PROJECT_PLAN.md).

## Early CLI Sketch

```bash
simple-tps init ./case-001
simple-tps validate ./case-001
simple-tps inspect ./case-001
simple-tps run examples/scripts/inspect_project.py --project ./case-001
```

## Docker

Build and run the CLI in Docker:

```bash
docker compose run --rm cli --help
docker compose run --rm cli inspect examples/demo-project
docker compose run --rm cli init cases/case-001
```

The Compose service bind-mounts this repo at `/workspace`, so paths are relative
to the repository root.

Host port `8013` is reserved in `docker-compose.yml` for the future app/API
service. It maps to container port `8000`.
