from pathlib import Path

import pytest

from simple_tps import Project, ProjectValidationError


def test_create_and_open_project(tmp_path: Path):
    project = Project.create(tmp_path / "case", patient_id="p1", patient_name="Patient One")

    reopened = Project.open(project.root)

    assert reopened.manifest["patient"]["id"] == "p1"
    assert reopened.inspect()["volumes"] == 1


def test_validate_reports_missing_files(tmp_path: Path):
    project = Project.create(tmp_path / "case")

    with pytest.raises(ProjectValidationError):
        project.validate(check_files=True)


def test_add_contour_updates_manifest(tmp_path: Path):
    project = Project.create(tmp_path / "case")
    project.add_contour("PTV", "PTV", "contours/PTV.mha", color="#e15759")

    reopened = Project.open(project.root)

    assert reopened.manifest["contours"][0]["id"] == "PTV"
