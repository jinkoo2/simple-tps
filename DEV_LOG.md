# Development Log

## 2026-05-12

- Created initial project planning notes in `PROJECT_PLAN.md`.
- Added initial `project.schema.json` for portable project-folder manifests.
- Decided on a local-first architecture:
  - `simple_tps` core Python library as the source of truth.
  - CLI and Python scripting call the core library directly.
  - FastAPI is a later adapter, not the foundation.
  - NiiVue GUI will be viewer-focused and should not own project logic.
- Added initial implementation scaffold:
  - Python package under `src/simple_tps`.
  - CLI entry point `simple-tps`.
  - Project manifest read/write/validation.
  - `init`, `validate`, `inspect`, and `run` commands.
  - Demo project manifest under `examples/demo-project`.
- Added Docker support for running the current CLI scaffold in a container.
- Reserved host port `8013` in Docker Compose for the future app/API service.
- Standardized project terminology on contour/contours in docs, schema, core
  library, examples, and tests.
- Added initial `simple-tps contour add` CLI command.
- Added `stps` as a short console-script alias for `simple-tps`.
- Updated user-facing examples to patient/patients.
- Added an Eclipse DICOM reference-import example for creating
  `patients/eclipse-001` from the stereophan 7-beam sample.
- Updated the Eclipse DICOM import example to generate `images/ct.mha` with
  SimpleITK by default.
- Expanded the Eclipse DICOM import example to generate compressed MHA RTDOSE
  images, compressed MHA contour masks, and `plans/plan.json` from RTPLAN.
- Added sidecar metadata JSON files for generated CT, dose, contour, structure,
  and plan objects, plus UID-based duplicate detection for import skipping.
- Updated DICOM import defaults to derive patient ID, patient name, and default
  patient folder from source DICOM metadata when not provided.
- Added an initial web viewer served by `simple-tps web` / `stps web`, using
  NiiVue in the browser to render CT, dose, and contour MHA objects from patient
  project folders.
- Added initial web security controls: optional HTTP Basic authentication,
  localhost-only Docker port publishing, safe file path resolution, and browser
  security headers.
- Added `.env` support for local web authentication variables and documented
  `.env.example`.
- Fixed NiiVue volume loading for contour objects by passing file names with
  extensions, and added a browser tab icon.
- Updated web overlay toggles to use NiiVue opacity changes instead of
  reloading all volumes, and defaulted the viewer to multiplanar slice mode.

## Open Implementation Notes

- Keep project format portable and human-inspectable.
- Keep all important project operations in the core library so GUI, CLI,
  scripting, and future FastAPI can share behavior.
- Treat Python scripts as trusted local code execution until/unless sandboxing is
  designed.
