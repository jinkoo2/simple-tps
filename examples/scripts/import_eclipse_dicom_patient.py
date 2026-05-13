"""Import an Eclipse DICOM export into a Simple TPS patient folder.

This copies the original DICOM files into the patient folder, converts DICOM
objects into Simple TPS working files, and records them in `project.json`.

Generated working files:
    images/ct.mha
    doses/rtdose-*.mha
    contours/*.mha
    plans/plan.json

Run from the repository root:
    python examples/scripts/import_eclipse_dicom_patient.py

Or explicitly:
    python examples/scripts/import_eclipse_dicom_patient.py \
        --source /home/jk/projects/tps/_sample_plans/eclipse_tps/stereophan_IMRT_7beams \
        --project patients/eclipse-001
"""

from __future__ import annotations

import argparse
import json
import math
import re
import shutil
from collections import defaultdict
from pathlib import Path
from typing import Any

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
    dose_images = []
    contour_masks = []
    plan_json = None
    if not args.no_convert_images:
        dose_images = convert_doses_to_mha(project, copied.get("rtdose", []), ct_image or ct_dir)
        contour_masks = convert_rtstruct_to_masks(project, copied.get("rtstruct", []), ct_image)
        plan_json = convert_rtplan_to_json(project, copied.get("rtplan", []))

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
    project.manifest["plans"] = build_plan_manifest_entries(plan_json, copied.get("rtplan", []))
    project.manifest["contours"] = build_contour_manifest_entries(contour_masks, copied.get("rtstruct", []))
    project.manifest["doses"] = build_dose_manifest_entries(dose_images, copied.get("rtdose", []), ct_image or ct_dir)
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
    if dose_images:
        project.manifest["dicom"]["dose_mha"] = [dose["path"] for dose in dose_images]
    if contour_masks:
        project.manifest["dicom"]["contour_masks"] = [contour["path"] for contour in contour_masks]
    if plan_json:
        project.manifest["dicom"]["plan_json"] = plan_json
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
    if dose_images:
        print(f"  Dose MHA  : {len(dose_images)}")
    if contour_masks:
        print(f"  Masks     : {len(contour_masks)}")
    if plan_json:
        print(f"  Plan JSON : {plan_json}")
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


def convert_doses_to_mha(project: Project, dose_paths: list[str], reference_image: str) -> list[dict[str, Any]]:
    converted = []
    for index, dose_path in enumerate(dose_paths, start=1):
        dataset = read_dicom_dataset(project.resolve_path(dose_path))
        image = rtdose_dataset_to_image(dataset)
        output_path = project.root / "doses" / f"rtdose-{index}.mha"
        output_path.parent.mkdir(parents=True, exist_ok=True)
        write_image(image, output_path)
        converted.append(
            {
                "id": f"rtdose-{index}",
                "path": output_path.relative_to(project.root).as_posix(),
                "units": normalize_dose_units(getattr(dataset, "DoseUnits", "Gy")),
                "format": "MHA",
                "source": dose_path,
                "reference_image": reference_image,
                "dose_type": str(getattr(dataset, "DoseType", "")),
                "dose_summation_type": str(getattr(dataset, "DoseSummationType", "")),
            }
        )
    return converted


def convert_rtstruct_to_masks(project: Project, rtstruct_paths: list[str], reference_image: str | None) -> list[dict[str, Any]]:
    if not reference_image:
        return []

    try:
        import numpy as np
        import SimpleITK as sitk
    except ImportError as exc:
        raise SystemExit(
            "SimpleITK and numpy are required to convert RTSTRUCT contours to masks.\n"
            "Install them with `python -m pip install -e \".[dicom]\"`, or rerun with --no-convert-images."
        ) from exc

    reference = sitk.ReadImage(str(project.resolve_path(reference_image)))
    size_x, size_y, size_z = reference.GetSize()
    masks = []

    for rtstruct_path in rtstruct_paths:
        dataset = read_dicom_dataset(project.resolve_path(rtstruct_path))
        used_ids: set[str] = set()
        roi_names = {
            int(roi.ROINumber): str(roi.ROIName)
            for roi in getattr(dataset, "StructureSetROISequence", [])
        }
        for roi_contour in getattr(dataset, "ROIContourSequence", []):
            roi_number = int(roi_contour.ReferencedROINumber)
            roi_name = roi_names.get(roi_number, f"ROI {roi_number}")
            mask = np.zeros((size_z, size_y, size_x), dtype=np.uint8)
            for contour in getattr(roi_contour, "ContourSequence", []):
                points = getattr(contour, "ContourData", None)
                if not points:
                    continue
                draw_contour_on_mask(reference, mask, [float(value) for value in points])
            if not mask.any():
                continue

            mask_image = sitk.GetImageFromArray(mask)
            mask_image.CopyInformation(reference)
            contour_id = unique_id(make_id(roi_name), used_ids)
            output_path = project.root / "contours" / f"{contour_id}.mha"
            output_path.parent.mkdir(parents=True, exist_ok=True)
            write_image(mask_image, output_path)
            masks.append(
                {
                    "id": contour_id,
                    "name": roi_name,
                    "path": output_path.relative_to(project.root).as_posix(),
                    "format": "MHA",
                    "source": rtstruct_path,
                    "roi_number": roi_number,
                    "color": contour_color(roi_contour),
                }
            )
    return masks


def convert_rtplan_to_json(project: Project, rtplan_paths: list[str]) -> str | None:
    if not rtplan_paths:
        return None

    plans = [extract_rtplan(read_dicom_dataset(project.resolve_path(path)), path) for path in rtplan_paths]
    output = plans[0] if len(plans) == 1 else {"plans": plans}
    output_path = project.root / "plans" / "plan.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as f:
        json.dump(output, f, indent=2)
        f.write("\n")
    return output_path.relative_to(project.root).as_posix()


def build_plan_manifest_entries(plan_json: str | None, rtplan_paths: list[str]) -> list[dict[str, Any]]:
    if plan_json:
        return [
            {
                "id": "plan",
                "path": plan_json,
                "format": "SIMPLE_TPS_PLAN_JSON",
                "source": rtplan_paths[0] if rtplan_paths else None,
            }
        ]
    return [{"id": f"rtplan-{index + 1}", "path": path, "format": "DICOM_RTPLAN"} for index, path in enumerate(rtplan_paths)]


def build_contour_manifest_entries(contour_masks: list[dict[str, Any]], rtstruct_paths: list[str]) -> list[dict[str, Any]]:
    if contour_masks:
        return contour_masks
    return [
        {
            "id": f"rtstruct-{index + 1}",
            "name": "RT Structure Set",
            "path": path,
            "format": "DICOM_RTSTRUCT",
        }
        for index, path in enumerate(rtstruct_paths)
    ]


def build_dose_manifest_entries(
    dose_images: list[dict[str, Any]],
    rtdose_paths: list[str],
    reference_image: str,
) -> list[dict[str, Any]]:
    if dose_images:
        return dose_images
    return [
        {
            "id": f"rtdose-{index + 1}",
            "path": path,
            "units": "Gy",
            "format": "DICOM_RTDOSE",
            "reference_image": reference_image,
        }
        for index, path in enumerate(rtdose_paths)
    ]


def rtdose_dataset_to_image(dataset: Any) -> Any:
    try:
        import numpy as np
        import SimpleITK as sitk
    except ImportError as exc:
        raise SystemExit(
            "SimpleITK and numpy are required to convert RTDOSE to MHA.\n"
            "Install them with `python -m pip install -e \".[dicom]\"`, or rerun with --no-convert-images."
        ) from exc

    dose = dataset.pixel_array.astype(np.float32) * float(getattr(dataset, "DoseGridScaling", 1.0))
    if dose.ndim == 2:
        dose = dose[np.newaxis, :, :]

    image = sitk.GetImageFromArray(dose)
    image.SetOrigin(tuple(float(value) for value in dataset.ImagePositionPatient))
    image.SetSpacing(dose_spacing(dataset))
    image.SetDirection(dose_direction(dataset))
    return image


def dose_spacing(dataset: Any) -> tuple[float, float, float]:
    row_spacing, column_spacing = [float(value) for value in dataset.PixelSpacing]
    offsets = [float(value) for value in getattr(dataset, "GridFrameOffsetVector", [1.0])]
    if len(offsets) > 1:
        z_spacing = abs(offsets[1] - offsets[0])
    else:
        z_spacing = float(getattr(dataset, "SliceThickness", 1.0))
    return (column_spacing, row_spacing, z_spacing)


def dose_direction(dataset: Any) -> tuple[float, ...]:
    import numpy as np

    orientation = [float(value) for value in dataset.ImageOrientationPatient]
    row = np.array(orientation[:3], dtype=float)
    column = np.array(orientation[3:], dtype=float)
    normal = np.cross(row, column)
    direction = np.column_stack([row, column, normal])
    return tuple(float(value) for value in direction.reshape(-1))


def draw_contour_on_mask(reference: Any, mask: Any, contour_data: list[float]) -> None:
    import numpy as np

    points = np.array(contour_data, dtype=float).reshape(-1, 3)
    continuous_indices = np.array(
        [reference.TransformPhysicalPointToContinuousIndex(tuple(point)) for point in points],
        dtype=float,
    )
    if len(continuous_indices) < 3:
        return

    z_index = int(round(float(np.mean(continuous_indices[:, 2]))))
    if z_index < 0 or z_index >= mask.shape[0]:
        return

    polygon_x = continuous_indices[:, 0]
    polygon_y = continuous_indices[:, 1]
    fill_polygon(mask[z_index], polygon_x, polygon_y)


def fill_polygon(slice_mask: Any, polygon_x: Any, polygon_y: Any) -> None:
    import numpy as np

    height, width = slice_mask.shape
    y_min = max(0, int(math.floor(float(np.min(polygon_y)))))
    y_max = min(height - 1, int(math.ceil(float(np.max(polygon_y)))))
    if y_min > y_max:
        return

    x1 = polygon_x
    y1 = polygon_y
    x2 = np.roll(polygon_x, -1)
    y2 = np.roll(polygon_y, -1)

    for row in range(y_min, y_max + 1):
        scan_y = row + 0.5
        active = (y1 <= scan_y) != (y2 <= scan_y)
        if not np.any(active):
            continue
        intersections = x1[active] + (scan_y - y1[active]) * (x2[active] - x1[active]) / (y2[active] - y1[active])
        intersections = np.sort(intersections)
        for left, right in zip(intersections[0::2], intersections[1::2]):
            x_start = max(0, int(math.ceil(float(left))))
            x_end = min(width - 1, int(math.floor(float(right))))
            if x_start <= x_end:
                slice_mask[row, x_start : x_end + 1] = 1


def extract_rtplan(dataset: Any, source_path: str) -> dict[str, Any]:
    return {
        "format": "SIMPLE_TPS_PLAN_JSON",
        "source": source_path,
        "sop_instance_uid": str(getattr(dataset, "SOPInstanceUID", "")),
        "label": str(getattr(dataset, "RTPlanLabel", "")),
        "name": str(getattr(dataset, "RTPlanName", "")),
        "date": str(getattr(dataset, "RTPlanDate", "")),
        "time": str(getattr(dataset, "RTPlanTime", "")),
        "manufacturer": str(getattr(dataset, "Manufacturer", "")),
        "modality": str(getattr(dataset, "Modality", "")),
        "fractions": extract_fraction_groups(dataset),
        "beams": [extract_beam(beam, dataset) for beam in getattr(dataset, "BeamSequence", [])],
    }


def extract_fraction_groups(dataset: Any) -> list[dict[str, Any]]:
    groups = []
    for group in getattr(dataset, "FractionGroupSequence", []):
        beam_metersets = {}
        for referenced_beam in getattr(group, "ReferencedBeamSequence", []):
            beam_metersets[int(referenced_beam.ReferencedBeamNumber)] = float_or_none(
                getattr(referenced_beam, "BeamMeterset", None)
            )
        groups.append(
            {
                "number": int_or_none(getattr(group, "FractionGroupNumber", None)),
                "fractions_planned": int_or_none(getattr(group, "NumberOfFractionsPlanned", None)),
                "beams": beam_metersets,
            }
        )
    return groups


def extract_beam(beam: Any, dataset: Any) -> dict[str, Any]:
    control_points = list(getattr(beam, "ControlPointSequence", []))
    first_cp = control_points[0] if control_points else None
    beam_number = int_or_none(getattr(beam, "BeamNumber", None))
    return {
        "number": beam_number,
        "name": str(getattr(beam, "BeamName", "")),
        "type": str(getattr(beam, "BeamType", "")),
        "radiation_type": str(getattr(beam, "RadiationType", "")),
        "treatment_machine": str(getattr(beam, "TreatmentMachineName", "")),
        "source_axis_distance_mm": float_or_none(getattr(beam, "SourceAxisDistance", None)),
        "meterset": meterset_for_beam(dataset, beam_number),
        "control_point_count": len(control_points),
        "isocenter_mm": number_list(getattr(first_cp, "IsocenterPosition", [])) if first_cp else [],
        "nominal_energy_mv": float_or_none(getattr(first_cp, "NominalBeamEnergy", None)) if first_cp else None,
        "gantry_angle_deg": float_or_none(getattr(first_cp, "GantryAngle", None)) if first_cp else None,
        "collimator_angle_deg": float_or_none(getattr(first_cp, "BeamLimitingDeviceAngle", None)) if first_cp else None,
        "couch_angle_deg": float_or_none(getattr(first_cp, "PatientSupportAngle", None)) if first_cp else None,
        "final_cumulative_meterset_weight": final_meterset_weight(control_points),
        "devices": extract_beam_devices(beam),
    }


def extract_beam_devices(beam: Any) -> list[dict[str, Any]]:
    devices = []
    for device in getattr(beam, "BeamLimitingDeviceSequence", []):
        devices.append(
            {
                "type": str(getattr(device, "RTBeamLimitingDeviceType", "")),
                "leaf_or_jaw_pairs": int_or_none(getattr(device, "NumberOfLeafJawPairs", None)),
            }
        )
    return devices


def meterset_for_beam(dataset: Any, beam_number: int | None) -> float | None:
    if beam_number is None:
        return None
    for group in getattr(dataset, "FractionGroupSequence", []):
        for referenced_beam in getattr(group, "ReferencedBeamSequence", []):
            if int(referenced_beam.ReferencedBeamNumber) == beam_number:
                return float_or_none(getattr(referenced_beam, "BeamMeterset", None))
    return None


def final_meterset_weight(control_points: list[Any]) -> float | None:
    if not control_points:
        return None
    return float_or_none(getattr(control_points[-1], "CumulativeMetersetWeight", None))


def read_dicom_dataset(path: Path) -> Any:
    try:
        import pydicom
    except ImportError as exc:
        raise SystemExit(
            "pydicom is required to import RTPLAN, RTSTRUCT, and RTDOSE.\n"
            "Install it with `python -m pip install -e \".[dicom]\"`."
        ) from exc
    return pydicom.dcmread(path)


def write_image(image: Any, output_path: Path) -> None:
    import SimpleITK as sitk

    sitk.WriteImage(image, str(output_path), useCompression=True)


def normalize_dose_units(units: Any) -> str:
    return "Gy" if str(units).upper() == "GY" else "cGy"


def contour_color(roi_contour: Any) -> str:
    color = getattr(roi_contour, "ROIDisplayColor", None)
    if color and len(color) >= 3:
        return "#" + "".join(f"{max(0, min(255, int(value))):02x}" for value in color[:3])
    return "#e15759"


def make_id(value: str) -> str:
    item_id = re.sub(r"[^a-zA-Z0-9]+", "-", value.strip().lower()).strip("-")
    return item_id or "item"


def unique_id(item_id: str, used_ids: set[str]) -> str:
    if item_id not in used_ids:
        used_ids.add(item_id)
        return item_id
    for index in range(2, 1000):
        candidate = f"{item_id}-{index}"
        if candidate not in used_ids:
            used_ids.add(candidate)
            return candidate
    raise RuntimeError(f"Could not create a unique id for {item_id}")


def float_or_none(value: Any) -> float | None:
    if value is None:
        return None
    return float(value)


def int_or_none(value: Any) -> int | None:
    if value is None:
        return None
    return int(value)


def number_list(values: Any) -> list[float]:
    return [float(value) for value in values]


if __name__ == "__main__":
    raise SystemExit(main())
