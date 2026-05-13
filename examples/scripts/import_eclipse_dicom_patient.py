"""Import an Eclipse DICOM export into a Simple TPS patient folder.

This copies the original DICOM files into the patient folder, converts the CT
series to `images/ct.mha`, and records CT, RTPLAN, RTDOSE, and RTSTRUCT
references in `project.json`.

Run from the repository root:
    python examples/scripts/import_eclipse_dicom_patient.py

Or explicitly:
    python examples/scripts/import_eclipse_dicom_patient.py \
        --source /home/jk/projects/tps/_sample_plans/eclipse_tps/stereophan_IMRT_7beams \
        --project patients/eclipse-001
"""

from __future__ import annotations

import argparse
import shutil
from collections import defaultdict
from pathlib import Path

from simple_tps.project import Project, ProjectValidationError


DEFAULT_SOURCE = Path("/home/jk/projects/tps/_sample_plans/eclipse_tps/stereophan_IMRT_7beams")
DEFAULT_PROJECT = Path("patients/eclipse-001")

DICOM_GROUPS = {
    "CT": "ct",
    "RTPLAN": "rtplan",
    "RTSTRUCT": "rtstruct",
    "RTDOSE": "rtdose",
}

FILENAME_PREFIX_GROUPS = {
    "CT": "ct",
    "RP": "rtplan",
    "RS": "rtstruct",
    "RD": "rtdose",
}


def main() -> int:
    args = parse_args()
    source = args.source.resolve()
    project_root = args.project.resolve()

    if not source.exists():
        raise SystemExit(f"Source folder does not exist: {source}")
    if not source.is_dir():
        raise SystemExit(f"Source path is not a folder: {source}")

    manifest_path = project_root / Project.MANIFEST_NAME
    if manifest_path.exists() and not args.overwrite:
        raise SystemExit(
            f"Project already exists: {project_root}\n"
            "Use --overwrite to update its manifest and overwrite copied DICOM files."
        )

    grouped = group_dicom_files(source)
    if not grouped["ct"]:
        raise SystemExit(f"No CT DICOM slices found in: {source}")
    if not grouped["rtplan"]:
        raise SystemExit(f"No RTPLAN DICOM file found in: {source}")
    if not grouped["rtstruct"]:
        raise SystemExit(f"No RTSTRUCT DICOM file found in: {source}")

    project = Project.create(
        project_root,
        patient_id=args.patient_id,
        patient_name=args.patient_name,
    )

    copied = {
        group_name: copy_group(project, files, group_name, overwrite=args.overwrite)
        for group_name, files in grouped.items()
        if files
    }

    ct_dir = "dicom/original/ct"
    ct_image = None
    if not args.no_convert_images:
        ct_image = convert_ct_series_to_mha(project, ct_dir)

    project.manifest["primary_image"] = ct_image or ct_dir
    project.manifest["volumes"] = [
        {
            "id": "ct_dicom",
            "type": "CT",
            "path": ct_dir,
            "format": "DICOM",
            "file_count": len(copied.get("ct", [])),
        }
    ]
    if ct_image:
        project.manifest["volumes"].insert(
            0,
            {
                "id": "ct",
                "type": "CT",
                "path": ct_image,
                "format": "MHA",
                "source": ct_dir,
            },
        )
    project.manifest["plans"] = [
        {
            "id": f"rtplan-{index + 1}",
            "path": path,
            "format": "DICOM_RTPLAN",
        }
        for index, path in enumerate(copied.get("rtplan", []))
    ]
    project.manifest["contours"] = [
        {
            "id": f"rtstruct-{index + 1}",
            "name": "RT Structure Set",
            "path": path,
            "format": "DICOM_RTSTRUCT",
        }
        for index, path in enumerate(copied.get("rtstruct", []))
    ]
    project.manifest["doses"] = [
        {
            "id": f"rtdose-{index + 1}",
            "path": path,
            "units": "Gy",
            "format": "DICOM_RTDOSE",
            "reference_image": ct_dir,
        }
        for index, path in enumerate(copied.get("rtdose", []))
    ]
    project.manifest["dicom"] = {
        "source": str(source),
        "import_type": "original_dicom_reference",
        "ct_slices": len(copied.get("ct", [])),
        "rtplan_files": len(copied.get("rtplan", [])),
        "rtstruct_files": len(copied.get("rtstruct", [])),
        "rtdose_files": len(copied.get("rtdose", [])),
        "other_files": len(copied.get("other", [])),
    }
    if ct_image:
        project.manifest["dicom"]["ct_mha"] = ct_image
    project.save()

    try:
        project.validate(check_files=True)
    except ProjectValidationError as exc:
        raise SystemExit(f"Imported project did not validate:\n{exc}") from exc

    print(f"Imported Eclipse DICOM patient: {project.root}")
    print(f"  CT slices : {len(copied.get('ct', []))}")
    print(f"  RTPLAN    : {len(copied.get('rtplan', []))}")
    print(f"  RTSTRUCT  : {len(copied.get('rtstruct', []))}")
    print(f"  RTDOSE    : {len(copied.get('rtdose', []))}")
    if ct_image:
        print(f"  CT MHA    : {ct_image}")
    print(f"  Manifest  : {project.manifest_path}")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE, help="Eclipse DICOM export folder")
    parser.add_argument("--project", type=Path, default=DEFAULT_PROJECT, help="Destination Simple TPS patient folder")
    parser.add_argument("--patient-id", default="eclipse-001")
    parser.add_argument("--patient-name", default="Eclipse Demo Patient")
    parser.add_argument("--overwrite", action="store_true", help="Update an existing patient manifest and copied files")
    parser.add_argument(
        "--no-convert-images",
        action="store_true",
        help="Copy DICOM only; do not convert the CT series to images/ct.mha",
    )
    return parser.parse_args()


def group_dicom_files(source: Path) -> defaultdict[str, list[Path]]:
    grouped: defaultdict[str, list[Path]] = defaultdict(list)
    for file_path in sorted(source.glob("*.dcm")):
        grouped[classify_dicom(file_path)].append(file_path)
    return grouped


def classify_dicom(file_path: Path) -> str:
    modality = read_modality(file_path)
    if modality in DICOM_GROUPS:
        return DICOM_GROUPS[modality]

    prefix = file_path.name.split(".", 1)[0].upper()
    return FILENAME_PREFIX_GROUPS.get(prefix, "other")


def read_modality(file_path: Path) -> str | None:
    try:
        import pydicom
    except ImportError:
        return None

    try:
        dataset = pydicom.dcmread(file_path, stop_before_pixels=True, specific_tags=["Modality"])
    except Exception:
        return None
    return str(getattr(dataset, "Modality", "")).upper() or None


def copy_group(project: Project, files: list[Path], group_name: str, overwrite: bool) -> list[str]:
    destination = project.root / "dicom" / "original" / group_name
    destination.mkdir(parents=True, exist_ok=True)

    relative_paths = []
    for source_file in files:
        destination_file = destination / source_file.name
        if overwrite or not destination_file.exists():
            shutil.copy2(source_file, destination_file)
        relative_paths.append(destination_file.relative_to(project.root).as_posix())
    return relative_paths


def convert_ct_series_to_mha(project: Project, ct_dir: str) -> str:
    try:
        import SimpleITK as sitk
    except ImportError as exc:
        raise SystemExit(
            "SimpleITK is required to convert CT DICOM to MHA.\n"
            "Install it with `python -m pip install -e \".[dicom]\"`, or rerun with --no-convert-images."
        ) from exc

    dicom_dir = project.resolve_path(ct_dir)
    series_ids = list(sitk.ImageSeriesReader.GetGDCMSeriesIDs(str(dicom_dir)) or [])
    if not series_ids:
        raise SystemExit(f"No readable CT DICOM series found in: {dicom_dir}")

    series_files = [
        sitk.ImageSeriesReader.GetGDCMSeriesFileNames(str(dicom_dir), series_id)
        for series_id in series_ids
    ]
    file_names = max(series_files, key=len)

    reader = sitk.ImageSeriesReader()
    reader.SetFileNames(file_names)
    image = reader.Execute()

    output_path = project.root / "images" / "ct.mha"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    sitk.WriteImage(image, str(output_path), useCompression=True)
    return output_path.relative_to(project.root).as_posix()


if __name__ == "__main__":
    raise SystemExit(main())
