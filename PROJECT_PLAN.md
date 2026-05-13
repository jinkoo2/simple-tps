# Simple TPS Project Plan

## Goal

Build a simple cross-platform treatment planning system focused on practical
review, contouring, dose viewing, and lightweight planning workflows.

The first version should be easy to run locally, keep data portable, and avoid
large infrastructure unless it is clearly needed.

## Initial Direction

- Visualization: NiiVue as the main image viewer.
- Primary image format: `.mha` / MetaImage for CT, dose, masks, and derived grids.
- App shape: local-first desktop/web app that can later grow into client/server.
- Scope: review and basic TPS workflows first, not a full clinical planning
  system at the start.

## Target Workflows

1. Open a patient/study workspace.
2. Load CT volume from `.mha`.
3. Load or create ROI masks.
4. Display dose overlays and dose color wash.
5. Inspect axial/coronal/sagittal views.
6. Show basic DVH and point dose readouts.
7. Save all state back into a portable project folder.
8. Export selected data for dose engines or external review.

## Proposed Architecture

### Frontend

- TypeScript.
- NiiVue for volume visualization.
- A small state layer for active patient, volumes, ROIs, dose, view state, and UI
  selections.
- Keep the UI quiet and work-focused: viewer-first layout, side panels for data
  and tools, bottom/status area for coordinates and dose readout.

Candidate app shells:

- Tauri: good cross-platform desktop packaging, local filesystem access, smaller
  than Electron.
- Electron: mature and flexible, but heavier.
- Browser-only static app: simplest for prototypes, but local file access and
  persistence are more awkward.

Initial recommendation: prototype in browser/Vite first, then wrap with Tauri
once the workflow is clear.

### Backend / Local Services

Start without a required backend if possible.

Use local filesystem project folders for the first version. Add a backend only
when needed for:

- Long-running dose calculation jobs.
- Multi-user or remote access.
- Database indexing across many patients.
- DICOM networking.
- Authentication and audit trails.

If a local backend becomes useful, use Python FastAPI because existing TPS and
dose tooling is already Python-heavy in this workspace.

### Core Library, CLI, And Scripting

Keep project logic out of the viewer-only frontend.

Create a shared core library that can be used by:

- The GUI.
- A command-line interface.
- Python automation scripts.
- A future local or remote backend.

The core library should own:

- Project folder read/write.
- Manifest validation.
- MHA loading/saving helpers.
- DICOM import/export helpers.
- ROI and dose metadata operations.
- Dose and ROI statistics.
- Planning metadata operations.

The CLI should be a thin wrapper around the same core library, for example:

```bash
simple-tps init ./case-001
simple-tps import dicom ./case-001 ./dicom-folder
simple-tps import mha ./case-001 --ct ct.mha
simple-tps roi add ./case-001 --name PTV --mask rois/PTV.mha --color "#e15759"
simple-tps dose add ./case-001 dose.mha --units Gy
simple-tps plan import ./case-001 plan.json
simple-tps validate ./case-001
simple-tps dvh ./case-001 --dose dose_primary --roi PTV
```

Python scripting should expose a stable package API, for example:

```python
from simple_tps import Project

p = Project.open("./case-001")
dose = p.dose("dose_primary")
ptv = p.roi("PTV")

print(dose.mean_in_roi(ptv))
p.save()
```

Then run scripts through the CLI:

```bash
simple-tps run scripts/check_plan.py --project ./case-001
```

Important safety note: user Python scripts are trusted local code execution.
They can read, write, delete files, and access system resources. For the first
version, treat scripting as a local power-user feature. If the app later becomes
multi-user or server-based, scripting must be sandboxed, permissioned, or
disabled by default.

## Data Storage Plan

### Recommended First Version: Portable Project Folder

Each case is a folder:

```text
case-name/
  project.json
  images/
    ct.mha
  doses/
    dose_primary.mha
  rois/
    BODY.mha
    PTV.mha
    Rectum.mha
  plans/
    plan.json
  dicom/
    original/
  derived/
  logs/
```

Benefits:

- Easy to inspect, copy, zip, back up, and debug.
- No database required for the first version.
- `.mha` files remain standalone and usable from Python/SimpleITK/OpenTPS.
- Good fit for local desktop use.

Limitations:

- Searching across many patients is limited.
- Concurrent multi-user editing is not handled.
- Metadata consistency depends on good project validation.

### `project.json`

Store case-level metadata and references:

```json
{
  "schema_version": 1,
  "patient": {
    "id": "demo",
    "name": "Demo Patient"
  },
  "primary_image": "images/ct.mha",
  "volumes": [
    {
      "id": "ct",
      "type": "CT",
      "path": "images/ct.mha"
    }
  ],
  "rois": [
    {
      "id": "PTV",
      "name": "PTV",
      "path": "rois/PTV.mha",
      "color": "#e15759"
    }
  ],
  "doses": [
    {
      "id": "dose_primary",
      "path": "doses/dose_primary.mha",
      "units": "Gy"
    }
  ]
}
```

### Later Storage Options

Add SQLite when there are many local cases and you need search/indexing:

- One app-level SQLite database indexing project folders.
- Keep image data in `.mha` files, not inside SQLite.
- Store thumbnails, recently opened projects, tags, and search metadata in DB.

Add server storage only later:

- PostgreSQL for metadata.
- Object storage or filesystem volume for `.mha` and DICOM files.
- FastAPI for job orchestration, user access, and audit logs.

## Image Format Notes

Use `.mha` for internal volumes:

- CT image.
- Dose grid.
- ROI binary masks.
- Derived/resampled volumes.

Keep DICOM import/export as boundary functionality:

- Import DICOM CT/RTSTRUCT/RTPLAN/RTDOSE into the project folder.
- Preserve originals under `dicom/original/`.
- Convert working data to `.mha` plus JSON metadata.

Important details:

- Define one coordinate convention early.
- Store origin, spacing, and direction consistently.
- Validate that every ROI/dose grid aligns with its reference image.
- Record dose units explicitly: Gy vs cGy.

## Core Modules

### Viewer

- NiiVue volume loading.
- CT window/level controls.
- Dose overlay controls.
- ROI overlay controls.
- Crosshair, voxel coordinate, patient coordinate, and sampled dose.

### Data Model

- Project manifest parser/writer.
- Volume registry.
- ROI registry.
- Dose registry.
- Validation for spacing/origin/direction compatibility.

### Import / Export

- Import `.mha` directly.
- Import DICOM series into `.mha`.
- Import RTSTRUCT as mask `.mha` files.
- Import RTDOSE as dose `.mha`.
- Export selected volumes and masks.

### Contouring

Start simple:

- Display masks.
- Toggle ROI visibility/color.
- Basic brush/editing can come later.

Later:

- Slice brush.
- Polygon contour.
- Interpolation between slices.
- Boolean ROI operations.

### Dose Tools

Start simple:

- Dose overlay.
- Dose value at cursor.
- Max/mean dose summary.
- DVH for selected ROIs.

Later:

- Isodose lines.
- Plan comparison.
- Gamma or dose difference.

### Planning

Start as metadata and review:

- Plan JSON viewer.
- Beam list.
- Isocenter marker.
- Beam geometry overlay if feasible.

Later:

- Beam editing.
- Dose engine integration.
- Optimization hooks.

## Milestones

### Milestone 0: Decisions

- Choose app shell: browser prototype vs Tauri from day one.
- Define project folder schema.
- Define coordinate convention.
- Choose whether masks are binary `.mha` per ROI or multi-label `.mha`.

Recommended initial choice:

- Browser/Vite prototype.
- Portable project folder.
- One binary `.mha` per ROI.
- `project.json` as source of truth.

### Milestone 1: Viewer Prototype

- Open a sample `.mha` CT.
- Display axial/coronal/sagittal views with NiiVue.
- Show cursor coordinates.
- Save/reopen a minimal `project.json`.

### Milestone 2: Dose and ROI Display

- Load ROI masks.
- Load dose `.mha`.
- Toggle overlays.
- Sample dose at cursor.
- Basic color/opacity controls.

### Milestone 3: Project Workflow

- Create/open/save project folder.
- Validate missing files and grid mismatches.
- Recent projects list.
- Basic error reporting.

### Milestone 4: Core Library And CLI

- Extract project read/write into a reusable core library.
- Add CLI entry point.
- Add `init`, `validate`, and `inspect` commands.
- Add CLI tests using a tiny demo project.
- Make sure GUI and CLI use the same project manifest code.

### Milestone 5: DICOM Import

- Import DICOM CT.
- Import RTSTRUCT to masks.
- Import RTDOSE to `.mha`.
- Preserve original DICOM files.

### Milestone 6: Python Scripting

- Expose `simple_tps.Project` Python API.
- Add `simple-tps run SCRIPT --project PROJECT_DIR`.
- Provide script examples for:
  - Printing case metadata.
  - Adding an ROI mask.
  - Computing ROI dose statistics.
  - Exporting a simple report.
- Clearly label scripts as trusted local code execution.

### Milestone 7: Analysis Tools

- DVH.
- ROI statistics.
- Dose statistics.
- Screenshot/export.

### Milestone 8: Planning/Dose Engine Integration

- Plan metadata editor.
- Beam list and isocenter display.
- Submit dose calculation job to a local or remote dose server.
- Load returned dose into project.

## Open Questions

- Should this be desktop-first with Tauri, or browser-first with optional desktop
  wrapper?
- Should ROI storage be one binary mask per ROI or a single label map?
- Should project files be human-editable JSON only, or should there be an app
  SQLite index later?
- How much DICOM fidelity is needed in version 1?
- Should dose calculation be integrated early or kept as an external service?
- Is contour editing part of the first real release, or only display/review?
- Should CLI and Python scripting be included before contour editing?
- Should scripting be local trusted Python only, or should there also be a
  restricted macro/plugin system later?

## Risks

- Coordinate mismatches between DICOM, `.mha`, NiiVue, and dose engines.
- Browser filesystem APIs may be limiting without Tauri/Electron.
- ROI editing can become complex quickly.
- DICOM RTSTRUCT conversion needs careful validation.
- Python scripting is powerful but unsafe for untrusted scripts.
- Clinical-looking software needs clear non-clinical/research labeling unless
  regulatory work is intended.

## Near-Term Recommendation

Build a viewer-first prototype before choosing heavy storage infrastructure.

Start with:

```text
simple-tps/
  PROJECT_PLAN.md
  schema/
    project.schema.json
  examples/
    demo-project/
```

Then create a minimal Vite/NiiVue app that can open a project folder and display
`ct.mha`, ROI masks, and dose overlays.
