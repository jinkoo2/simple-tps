# Simple TPS

Planning notes for a simple cross-platform treatment planning system using
NiiVue for visualization and `.mha` files for working image data.

Start with [PROJECT_PLAN.md](PROJECT_PLAN.md).

## Installation

### Option 1: Without Docker

```bash
conda activate simple-tps
cd /home/jk/projects/tps/simple-tps
python -m pip install -e .
```

Verify the install:

```bash
simple-tps --help
```

### Option 2: With Docker

Build the image:

```bash
cd /home/jk/projects/tps/simple-tps
docker compose build cli
```

Verify the Dockerized CLI:

```bash
docker compose run --rm cli --help
```

The Compose service bind-mounts this repo at `/workspace`, so paths passed to
the CLI are relative to the repository root.

Host port `8013` is reserved in `docker-compose.yml` for the future app/API
service. It maps to container port `8000`.

## Basic Usage

Create a project folder:

```bash
simple-tps init cases/case-001 --patient-id case-001 --patient-name "Demo Patient"
```

Inspect the project:

```bash
simple-tps inspect cases/case-001
```

Validate only the manifest:

```bash
simple-tps validate cases/case-001 --skip-files
```

Validate the manifest and referenced files:

```bash
simple-tps validate cases/case-001
```

Run a trusted Python automation script:

```bash
simple-tps run examples/scripts/inspect_project.py --project examples/demo-project
```

The project manifest is `project.json` inside each project folder. Image, dose,
ROI, plan, and DICOM files are stored as ordinary files under that folder.

## Docker Usage

Run the same CLI commands through Docker:

```bash
docker compose run --rm cli --help
docker compose run --rm cli inspect examples/demo-project
docker compose run --rm cli init cases/case-001
```
