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

    p_contour = sub.add_parser("contour", help="manage contour masks")
    contour_sub = p_contour.add_subparsers(required=True)

    p_contour_add = contour_sub.add_parser("add", help="add a contour mask to a project")
    p_contour_add.add_argument("project_dir")
    p_contour_add.add_argument("--name", required=True)
    p_contour_add.add_argument("--mask", required=True, help="project-relative mask path")
    p_contour_add.add_argument("--id", dest="contour_id", default=None)
    p_contour_add.add_argument("--color", default=None)
    p_contour_add.set_defaults(func=cmd_contour_add)

    p_run = sub.add_parser("run", help="run a trusted Python automation script")
    p_run.add_argument("script")
    p_run.add_argument("--project", required=True, help="project folder passed to the script")
    p_run.set_defaults(func=cmd_run)

    p_web = sub.add_parser("web", help="start the Simple TPS web viewer")
    p_web.add_argument("--host", default="127.0.0.1")
    p_web.add_argument("--port", type=int, default=8013)
    p_web.add_argument("--patients-root", default="patients")
    p_web.add_argument("--patient", default=None, help="patient folder name to open first")
    p_web.add_argument("--auth-user", default=None, help="enable HTTP Basic auth with this username")
    p_web.add_argument("--auth-password", default=None, help="enable HTTP Basic auth with this password")
    p_web.set_defaults(func=cmd_web)

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


def cmd_contour_add(args: argparse.Namespace) -> int:
    project = Project.open(args.project_dir)
    contour_id = args.contour_id or args.name
    project.add_contour(contour_id, args.name, args.mask, color=args.color)
    print(f"added contour: {contour_id}")
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


def cmd_web(args: argparse.Namespace) -> int:
    from .web import run_server

    run_server(
        args.host,
        args.port,
        args.patients_root,
        default_patient=args.patient,
        auth_user=args.auth_user,
        auth_password=args.auth_password,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
