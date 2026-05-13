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

## Open Implementation Notes

- Keep project format portable and human-inspectable.
- Keep all important project operations in the core library so GUI, CLI,
  scripting, and future FastAPI can share behavior.
- Treat Python scripts as trusted local code execution until/unless sandboxing is
  designed.
