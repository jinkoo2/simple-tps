"""Command-line interface for Simple TPS."""

from __future__ import annotations

import argparse
import json
import runpy
import sys
from pathlib import Path

from .project import Project, ProjectValidationError


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except ProjectValidationError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="simple-tps")
    sub = parser.add_subparsers(required=True)

    p_init = sub.add_parser("init", help="create a project folder")
    p_init.add_argument("project_dir")
    p_init.add_argument("--patient-id", default="demo")
    p_init.add_argument("--patient-name", default="Demo Patient")
    p_init.set_defaults(func=cmd_init)

    p_validate = sub.add_parser("validate", help="validate a project folder")
    p_validate.add_argument("project_dir")
    p_validate.add_argument("--skip-files", action="store_true", help="validate manifest only")
    p_validate.set_defaults(func=cmd_validate)

    p_inspect = sub.add_parser("inspect", help="print project summary")
    p_inspect.add_argument("project_dir")
    p_inspect.set_defaults(func=cmd_inspect)

    p_run = sub.add_parser("run", help="run a trusted Python automation script")
    p_run.add_argument("script")
    p_run.add_argument("--project", required=True, help="project folder passed to the script")
    p_run.set_defaults(func=cmd_run)

    return parser


def cmd_init(args: argparse.Namespace) -> int:
    project = Project.create(args.project_dir, patient_id=args.patient_id, patient_name=args.patient_name)
    print(f"created project: {project.root}")
    return 0


def cmd_validate(args: argparse.Namespace) -> int:
    project = Project.open(args.project_dir)
    project.validate(check_files=not args.skip_files)
    print("valid")
    return 0


def cmd_inspect(args: argparse.Namespace) -> int:
    project = Project.open(args.project_dir)
    print(json.dumps(project.inspect(), indent=2))
    return 0


def cmd_run(args: argparse.Namespace) -> int:
    script = Path(args.script).resolve()
    project = Project.open(args.project)
    globals_for_script = {
        "__name__": "__main__",
        "PROJECT_DIR": str(project.root),
        "project": project,
    }
    runpy.run_path(str(script), init_globals=globals_for_script)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
