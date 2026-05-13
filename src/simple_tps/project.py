"""Project-folder manifest handling for Simple TPS."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any


class ProjectValidationError(ValueError):
    """Raised when a project manifest or folder is invalid."""


@dataclass
class Project:
    """A portable Simple TPS project folder.

    The project folder stores a `project.json` manifest plus image, dose, contour,
    plan, DICOM, and derived files in ordinary subdirectories.
    """

    root: Path
    manifest: dict[str, Any]

    MANIFEST_NAME = "project.json"

    @classmethod
    def create(cls, root: str | Path, patient_id: str = "demo", patient_name: str = "Demo Patient") -> "Project":
        root_path = Path(root).resolve()
        root_path.mkdir(parents=True, exist_ok=True)
        for child in ("images", "doses", "contours", "plans", "dicom/original", "derived", "logs"):
            (root_path / child).mkdir(parents=True, exist_ok=True)

        manifest = {
            "schema_version": 1,
            "patient": {
                "id": patient_id,
                "name": patient_name,
            },
            "primary_image": "images/ct.mha",
            "volumes": [
                {
                    "id": "ct",
                    "type": "CT",
                    "path": "images/ct.mha",
                }
            ],
            "contours": [],
            "doses": [],
            "plans": [],
        }
        project = cls(root=root_path, manifest=manifest)
        project.save()
        return project

    @classmethod
    def open(cls, root: str | Path) -> "Project":
        root_path = Path(root).resolve()
        manifest_path = root_path / cls.MANIFEST_NAME
        if not manifest_path.exists():
            raise ProjectValidationError(f"Missing manifest: {manifest_path}")
        with manifest_path.open("r", encoding="utf-8") as f:
            manifest = json.load(f)
        project = cls(root=root_path, manifest=manifest)
        project.validate(check_files=False)
        return project

    @property
    def manifest_path(self) -> Path:
        return self.root / self.MANIFEST_NAME

    def save(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        with self.manifest_path.open("w", encoding="utf-8") as f:
            json.dump(self.manifest, f, indent=2)
            f.write("\n")

    def resolve_path(self, relative_path: str) -> Path:
        path = Path(relative_path)
        if path.is_absolute():
            raise ProjectValidationError(f"Project paths must be relative: {relative_path}")
        return self.root / path

    def validate(self, check_files: bool = True) -> list[str]:
        errors: list[str] = []
        manifest = self.manifest

        if manifest.get("schema_version") != 1:
            errors.append("schema_version must be 1")
        if not manifest.get("primary_image"):
            errors.append("primary_image is required")
        if not isinstance(manifest.get("volumes"), list) or not manifest["volumes"]:
            errors.append("volumes must contain at least one volume")

        for collection_name in ("volumes", "contours", "doses", "plans"):
            collection = manifest.get(collection_name, [])
            if not isinstance(collection, list):
                errors.append(f"{collection_name} must be a list")
                continue
            for item in collection:
                self._validate_item(collection_name, item, errors, check_files)

        if check_files:
            primary = manifest.get("primary_image")
            if primary and not self.resolve_path(primary).exists():
                errors.append(f"primary_image does not exist: {primary}")

        if errors:
            raise ProjectValidationError("\n".join(errors))
        return errors

    def inspect(self) -> dict[str, Any]:
        return {
            "root": str(self.root),
            "patient": self.manifest.get("patient", {}),
            "primary_image": self.manifest.get("primary_image"),
            "volumes": len(self.manifest.get("volumes", [])),
            "contours": len(self.manifest.get("contours", [])),
            "doses": len(self.manifest.get("doses", [])),
            "plans": len(self.manifest.get("plans", [])),
        }

    def add_contour(self, contour_id: str, name: str, path: str, color: str | None = None) -> None:
        contour = {"id": contour_id, "name": name, "path": path}
        if color:
            contour["color"] = color
        self.manifest.setdefault("contours", []).append(contour)
        self.save()

    def add_dose(self, dose_id: str, path: str, units: str = "Gy", reference_image: str | None = None) -> None:
        dose = {"id": dose_id, "path": path, "units": units}
        if reference_image:
            dose["reference_image"] = reference_image
        self.manifest.setdefault("doses", []).append(dose)
        self.save()

    def _validate_item(
        self,
        collection_name: str,
        item: Any,
        errors: list[str],
        check_files: bool,
    ) -> None:
        if not isinstance(item, dict):
            errors.append(f"{collection_name} item must be an object")
            return
        for key in ("id", "path"):
            if not item.get(key):
                errors.append(f"{collection_name} item missing {key}")
        if collection_name == "contours" and not item.get("name"):
            errors.append("contour item missing name")
        if collection_name == "doses" and item.get("units") not in ("Gy", "cGy"):
            errors.append("dose units must be Gy or cGy")
        path = item.get("path")
        if path:
            try:
                resolved = self.resolve_path(path)
            except ProjectValidationError as exc:
                errors.append(str(exc))
                return
            if check_files and not resolved.exists():
                errors.append(f"{collection_name} file does not exist: {path}")
