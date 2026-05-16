"""Small development web server for the Simple TPS viewer."""

from __future__ import annotations

import json
import mimetypes
import os
import re
from base64 import b64decode
from hmac import compare_digest
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from importlib import resources
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

from .project import Project, ProjectValidationError


class ViewerServer(ThreadingHTTPServer):
    def __init__(
        self,
        server_address: tuple[str, int],
        handler_class: type[SimpleHTTPRequestHandler],
        patients_root: Path,
        default_patient: str | None = None,
        auth_user: str | None = None,
        auth_password: str | None = None,
    ) -> None:
        super().__init__(server_address, handler_class)
        self.patients_root = patients_root.resolve()
        self.default_patient = default_patient
        self.auth_user = auth_user
        self.auth_password = auth_password
        static_root = resources.files("simple_tps").joinpath("web_static")
        self.static_root = Path(str(static_root))


class ViewerHandler(SimpleHTTPRequestHandler):
    server: ViewerServer

    def log_message(self, format: str, *args: Any) -> None:
        print(f"{self.address_string()} - {format % args}")

    def do_GET(self) -> None:
        if not self.is_authorized():
            self.require_auth()
            return

        parsed = urlparse(self.path)
        path = unquote(parsed.path)

        if path == "/":
            self.serve_static("index.html")
            return
        if path == "/favicon.ico":
            self.serve_static("favicon.svg")
            return
        if path.startswith("/static/"):
            self.serve_static(path.removeprefix("/static/"))
            return
        if path == "/api/config":
            self.send_json(
                {
                    "patients_root": str(self.server.patients_root),
                    "default_patient": self.server.default_patient,
                }
            )
            return
        if path == "/api/patients":
            self.send_json({"patients": self.list_patients()})
            return
        if path.startswith("/api/patients/"):
            self.serve_patient_api(path)
            return
        if path.startswith("/patients/"):
            self.serve_patient_file(path)
            return

        self.send_error(HTTPStatus.NOT_FOUND, "Not found")

    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        super().end_headers()

    def is_authorized(self) -> bool:
        if not self.server.auth_user or not self.server.auth_password:
            return True

        header = self.headers.get("Authorization", "")
        if not header.startswith("Basic "):
            return False
        try:
            decoded = b64decode(header.removeprefix("Basic "), validate=True).decode("utf-8")
        except Exception:
            return False
        user, separator, password = decoded.partition(":")
        if not separator:
            return False
        return compare_digest(user, self.server.auth_user) and compare_digest(password, self.server.auth_password)

    def require_auth(self) -> None:
        self.send_response(HTTPStatus.UNAUTHORIZED)
        self.send_header("WWW-Authenticate", 'Basic realm="Simple TPS"')
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.end_headers()
        self.wfile.write(b"Authentication required\n")

    def serve_static(self, relative_path: str) -> None:
        path = safe_join(self.server.static_root, relative_path)
        if not path or not path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND, "Static file not found")
            return
        self.send_file(path)

    def serve_patient_api(self, path: str) -> None:
        parts = path.removeprefix("/api/patients/").split("/")
        patient_key = parts[0]
        project_dir = self.patient_dir(patient_key)
        if not project_dir:
            self.send_error(HTTPStatus.NOT_FOUND, "Patient not found")
            return
        if len(parts) == 1 or parts[1] == "project":
            try:
                project = Project.open(project_dir)
                project.validate(check_files=True)
            except ProjectValidationError as exc:
                self.send_error(HTTPStatus.BAD_REQUEST, str(exc))
                return
            self.send_json(project_payload(patient_key, project))
            return
        if len(parts) == 4 and parts[1] == "contours":
            try:
                index = int(parts[2])
                project = Project.open(project_dir)
                if parts[3] == "border.mha":
                    self.send_file(contour_border_path(project, index))
                    return
                if parts[3] == "surface.obj":
                    self.send_file(contour_surface_path(project, index))
                    return
            except (ImportError, IndexError, OSError, ProjectValidationError, RuntimeError, ValueError) as exc:
                self.send_error(HTTPStatus.BAD_REQUEST, str(exc))
                return
        self.send_error(HTTPStatus.NOT_FOUND, "Patient API not found")

    def serve_patient_file(self, path: str) -> None:
        parts = path.removeprefix("/patients/").split("/", 1)
        if len(parts) != 2:
            self.send_error(HTTPStatus.NOT_FOUND, "Patient file not found")
            return
        patient_key, relative_path = parts
        project_dir = self.patient_dir(patient_key)
        if not project_dir:
            self.send_error(HTTPStatus.NOT_FOUND, "Patient not found")
            return
        file_path = safe_join(project_dir, relative_path)
        if not file_path or not file_path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND, "Patient file not found")
            return
        self.send_file(file_path)

    def list_patients(self) -> list[dict[str, Any]]:
        root = self.server.patients_root
        if not root.exists():
            return []
        patients = []
        for manifest_path in sorted(root.glob("*/project.json")):
            project_dir = manifest_path.parent
            key = project_dir.name
            try:
                project = Project.open(project_dir)
                patient = project.manifest.get("patient", {})
            except ProjectValidationError:
                patient = {}
            patients.append(
                {
                    "key": key,
                    "path": str(project_dir),
                    "patient": patient,
                }
            )
        return patients

    def patient_dir(self, patient_key: str) -> Path | None:
        candidate = safe_join(self.server.patients_root, patient_key)
        if not candidate or not (candidate / Project.MANIFEST_NAME).is_file():
            return None
        return candidate

    def send_file(self, path: Path) -> None:
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if path.suffix.lower() in {".mha", ".raw"}:
            content_type = "application/octet-stream"
        data = path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, payload: dict[str, Any]) -> None:
        data = json.dumps(payload, indent=2).encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)


def run_server(
    host: str,
    port: int,
    patients_root: str | Path,
    default_patient: str | None = None,
    auth_user: str | None = None,
    auth_password: str | None = None,
) -> None:
    load_dotenv()
    auth_user = auth_user or os.environ.get("SIMPLE_TPS_AUTH_USER")
    auth_password = auth_password or os.environ.get("SIMPLE_TPS_AUTH_PASSWORD")
    server = ViewerServer(
        (host, port),
        ViewerHandler,
        Path(patients_root),
        default_patient=default_patient,
        auth_user=auth_user,
        auth_password=auth_password,
    )
    print(f"Simple TPS viewer: http://{host}:{port}")
    print(f"Patients root    : {server.patients_root}")
    if default_patient:
        print(f"Default patient  : {default_patient}")
    if auth_user and auth_password:
        print(f"Authentication   : enabled for user {auth_user!r}")
    else:
        print("Authentication   : disabled; bind to 127.0.0.1 for local-only use")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping Simple TPS viewer")
    finally:
        server.server_close()


def project_payload(patient_key: str, project: Project) -> dict[str, Any]:
    manifest = project.manifest
    return {
        "key": patient_key,
        "root": str(project.root),
        "manifest": manifest,
        "primary_image": object_with_url(patient_key, manifest.get("primary_image")),
        "volumes": objects_with_urls(patient_key, project, manifest.get("volumes", [])),
        "contours": objects_with_urls(patient_key, project, manifest.get("contours", [])),
        "doses": objects_with_urls(patient_key, project, manifest.get("doses", [])),
        "plans": objects_with_urls(patient_key, project, manifest.get("plans", [])),
    }


def objects_with_urls(patient_key: str, project: Project, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    payload = []
    for index, item in enumerate(items):
        object_payload = {
            **item,
            "url": patient_file_url(patient_key, item.get("path")),
            "metadata_url": patient_file_url(patient_key, item.get("metadata")),
            "metadata_json": read_object_metadata(project, item),
        }
        if (item.get("path") or "").startswith("contours/"):
            object_payload["border_url"] = f"/api/patients/{patient_key}/contours/{index}/border.mha"
            object_payload["surface_url"] = f"/api/patients/{patient_key}/contours/{index}/surface.obj"
        payload.append(object_payload)
    return payload


def object_with_url(patient_key: str, path: str | None) -> dict[str, str] | None:
    if not path:
        return None
    return {"path": path, "url": patient_file_url(patient_key, path)}


def patient_file_url(patient_key: str, path: str | None) -> str | None:
    if not path:
        return None
    return f"/patients/{patient_key}/{path}"


def read_object_metadata(project: Project, item: dict[str, Any]) -> dict[str, Any] | None:
    metadata_path = item.get("metadata")
    if not metadata_path:
        return None
    path = project.resolve_path(metadata_path)
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None


def contour_border_path(project: Project, index: int) -> Path:
    import SimpleITK as sitk

    contour = project.manifest.get("contours", [])[index]
    source = project.resolve_path(contour.get("path", ""))
    if not source.is_file():
        raise RuntimeError("Contour mask file not found")
    cache = derived_contour_path(project, contour, ".border.mha")
    if cache.is_file() and cache.stat().st_mtime >= source.stat().st_mtime:
        return cache

    image = sitk.ReadImage(str(source))
    mask = sitk.BinaryThreshold(image, lowerThreshold=0.5, upperThreshold=1.0e9, insideValue=1, outsideValue=0)
    border = sitk.BinaryContour(mask, fullyConnected=False, foregroundValue=1, backgroundValue=0)
    border.CopyInformation(image)
    cache.parent.mkdir(parents=True, exist_ok=True)
    sitk.WriteImage(border, str(cache), True)
    return cache


def contour_surface_path(project: Project, index: int) -> Path:
    import numpy as np
    import SimpleITK as sitk
    from skimage import measure

    contour = project.manifest.get("contours", [])[index]
    source = project.resolve_path(contour.get("path", ""))
    if not source.is_file():
        raise RuntimeError("Contour mask file not found")
    cache = derived_contour_path(project, contour, ".surface.v2.obj")
    if cache.is_file() and cache.stat().st_mtime >= source.stat().st_mtime:
        return cache

    image = sitk.ReadImage(str(source))
    mask = sitk.GetArrayFromImage(image) > 0
    if not np.any(mask):
        raise RuntimeError("Contour mask is empty")

    vertices_zyx, faces, _normals, _values = measure.marching_cubes(
        mask.astype(np.float32),
        level=0.5,
        step_size=2,
        allow_degenerate=False,
    )
    vertices_xyz = vertices_zyx[:, [2, 1, 0]]
    spacing = np.asarray(image.GetSpacing(), dtype=np.float64)
    origin = np.asarray(image.GetOrigin(), dtype=np.float64)
    direction = np.asarray(image.GetDirection(), dtype=np.float64).reshape(3, 3)
    physical = origin + (vertices_xyz * spacing) @ direction.T

    cache.parent.mkdir(parents=True, exist_ok=True)
    with cache.open("w", encoding="utf-8") as handle:
        handle.write(f"# Simple TPS contour surface: {contour.get('name') or contour.get('id') or index}\n")
        for x, y, z in physical:
            handle.write(f"v {x:.6f} {y:.6f} {z:.6f}\n")
        for a, b, c in faces + 1:
            handle.write(f"f {int(a)} {int(b)} {int(c)}\n")
    return cache


def derived_contour_path(project: Project, contour: dict[str, Any], suffix: str) -> Path:
    name = contour.get("id") or contour.get("name") or Path(contour.get("path", "contour")).stem
    safe_name = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(name)).strip("._") or "contour"
    return project.root / "derived" / "contours" / f"{safe_name}{suffix}"


def safe_join(root: Path, relative_path: str) -> Path | None:
    candidate = (root / relative_path).resolve()
    try:
        candidate.relative_to(root.resolve())
    except ValueError:
        return None
    return candidate


def load_dotenv(path: str | Path = ".env") -> None:
    env_path = Path(path)
    if not env_path.is_file():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        parsed = parse_env_line(line)
        if not parsed:
            continue
        key, value = parsed
        os.environ.setdefault(key, value)


def parse_env_line(line: str) -> tuple[str, str] | None:
    stripped = line.strip()
    if not stripped or stripped.startswith("#") or "=" not in stripped:
        return None
    key, value = stripped.split("=", 1)
    key = key.strip()
    if not key:
        return None
    return key, unquote_env_value(value.strip())


def unquote_env_value(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value
