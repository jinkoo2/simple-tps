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
stps --help
```

Both commands are installed by the project and run the same CLI.

For DICOM import and CT conversion examples, install the imaging dependency:

```bash
python -m pip install -e ".[dicom]"
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
simple-tps init patients/patient-001 --patient-id patient-001 --patient-name "Demo Patient"
```

You can use `stps` anywhere `simple-tps` is shown:

```bash
stps inspect examples/demo-project
```

Inspect the project:

```bash
simple-tps inspect patients/patient-001
```

Validate only the manifest:

```bash
simple-tps validate patients/patient-001 --skip-files
```

Validate the manifest and referenced files:

```bash
simple-tps validate patients/patient-001
```

Add a contour mask to the manifest:

```bash
simple-tps contour add patients/patient-001 --name PTV --mask contours/PTV.mha --color "#e15759"
```

Import the Eclipse stereophan 7-beam DICOM sample as original DICOM references:

```bash
python examples/scripts/import_eclipse_dicom_patient.py \
  --source /home/jk/projects/tps/_sample_plans/eclipse_tps/stereophan_IMRT_7beams \
  --project patients/eclipse-001

stps inspect patients/eclipse-001
```

The sample folder name on disk is `stereophan_IMRT_7beams`. This example copies
CT, RTPLAN, RTDOSE, and RTSTRUCT files into `patients/eclipse-001/dicom/original`,
writes compressed MHA working files for the CT, dose, and contour masks, creates
`patients/eclipse-001/plans/plan.json`, writes sidecar metadata JSON files next
to each generated object, and updates `patients/eclipse-001/project.json`.

If `--patient-id`, `--patient-name`, or `--project` are omitted, the importer
uses patient metadata from the DICOM files and derives the patient folder from
the DICOM PatientID. Existing generated objects are skipped when their sidecar
metadata UIDs match the incoming DICOM objects; use `--overwrite` to regenerate
them.

Run a trusted Python automation script:

```bash
simple-tps run examples/scripts/inspect_project.py --project examples/demo-project
```

Start the web viewer:

```bash
stps web --port 8013 --patients-root patients --patient eclipse-001
```

Open `http://127.0.0.1:8013` in a browser. The viewer lists patient projects
under `patients/`, loads `project.json`, and sends CT, dose, and contour MHA
objects to NiiVue in the browser.

Start the viewer with HTTP Basic authentication:

```bash
stps web --port 8013 --patients-root patients --patient eclipse-001 \
  --auth-user tps --auth-password "change-this-password"
```

You can also set `SIMPLE_TPS_AUTH_USER` and `SIMPLE_TPS_AUTH_PASSWORD` in a
local `.env` file instead of passing credentials on the command line:

```bash
cp .env.example .env
# edit .env and set a real password
stps web --port 8013 --patients-root patients --patient eclipse-001
```

Keep the default `--host 127.0.0.1` for local-only access. If you need access
from another machine, put the app behind a TLS reverse proxy and set explicit
credentials.

The project manifest is `project.json` inside each project folder. Image, dose,
contour mask, plan, and DICOM files are stored as ordinary files under that
folder.

## Docker Usage

Run the same CLI commands through Docker:

```bash
docker compose run --rm cli --help
docker compose run --rm cli inspect examples/demo-project
docker compose run --rm cli init patients/patient-001
```

Run the web viewer through Docker:

```bash
docker compose up app
```

Docker Compose reads the same `.env` file and publishes the viewer on
`127.0.0.1:8013` by default:

```bash
cp .env.example .env
# edit .env and set a real password
docker compose up app
```
