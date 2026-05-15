import { Niivue } from "https://unpkg.com/@niivue/niivue@0.57.0/dist/index.js";

const state = {
  config: null,
  patients: [],
  project: null,
  selected: {
    dose: new Set(),
    contour: new Set(),
  },
  nv: null,
};

const el = {
  status: document.getElementById("server-status"),
  patientSelect: document.getElementById("patient-select"),
  planSummary: document.getElementById("plan-summary"),
  objectList: document.getElementById("object-list"),
  loadStatus: document.getElementById("load-status"),
  reloadButton: document.getElementById("reload-button"),
};

async function main() {
  state.nv = new Niivue({
    backColor: [0.02, 0.025, 0.03, 1],
    crosshairColor: [0.1, 0.85, 0.72, 1],
    textHeight: 0.035,
  });
  await state.nv.attachTo("niivue-canvas");

  el.reloadButton.addEventListener("click", () => loadSelectedPatient());
  el.patientSelect.addEventListener("change", () => loadSelectedPatient());

  state.config = await fetchJson("/api/config");
  await loadPatients();
  selectInitialPatient();
  await loadSelectedPatient();
}

async function loadPatients() {
  const payload = await fetchJson("/api/patients");
  state.patients = payload.patients;
  el.patientSelect.replaceChildren();

  for (const patient of state.patients) {
    const option = document.createElement("option");
    option.value = patient.key;
    option.textContent = patientLabel(patient);
    el.patientSelect.append(option);
  }

  el.status.textContent = `${state.patients.length} patient${state.patients.length === 1 ? "" : "s"}`;
}

function selectInitialPatient() {
  if (!state.patients.length) {
    return;
  }
  const defaultPatient = state.config.default_patient;
  const match = state.patients.find((patient) => patient.key === defaultPatient);
  el.patientSelect.value = (match || state.patients[0]).key;
}

async function loadSelectedPatient() {
  const patientKey = el.patientSelect.value;
  if (!patientKey) {
    el.loadStatus.textContent = "No patient found";
    return;
  }

  el.loadStatus.textContent = "Loading patient";
  state.project = await fetchJson(`/api/patients/${encodeURIComponent(patientKey)}/project`);
  initializeObjectSelection();
  renderProjectPanel();
  renderObjectList();
  await renderVolumes();
}

function initializeObjectSelection() {
  state.selected.dose = new Set(state.project.doses.map((_, index) => index));
  state.selected.contour = new Set(state.project.contours.map((_, index) => index));
}

async function renderVolumes() {
  const project = state.project;
  const base = project.volumes.find((volume) => volume.id === "ct" && volume.url) || project.volumes.find((volume) => volume.url);
  if (!base) {
    el.loadStatus.textContent = "No loadable image volume";
    return;
  }

  const volumes = [
    volumeDescriptor(base, "CT", "gray", 1),
  ];

  project.doses.forEach((dose, index) => {
    if (dose.url && state.selected.dose.has(index)) {
      volumes.push(volumeDescriptor(dose, "Dose", "hot", 0.36));
    }
  });

  project.contours.forEach((contour, index) => {
    if (contour.url && state.selected.contour.has(index)) {
      volumes.push(volumeDescriptor(contour, "Contour", "red", 0.46));
    }
  });

  try {
    await state.nv.loadVolumes(volumes);
    el.loadStatus.textContent = `${volumes.length} volume${volumes.length === 1 ? "" : "s"} loaded`;
  } catch (error) {
    console.error(error);
    el.loadStatus.textContent = `Load failed: ${error.message || error}`;
  }
}

function volumeDescriptor(item, fallbackName, colormap, opacity) {
  return {
    url: item.url,
    name: volumeFileName(item, fallbackName),
    colormap,
    opacity,
    visible: true,
  };
}

function volumeFileName(item, fallbackName) {
  const source = item.path || item.name || item.id || fallbackName;
  const fileName = String(source).split("/").pop() || fallbackName;
  return fileName.includes(".") ? fileName : `${fileName}.mha`;
}

function renderProjectPanel() {
  const manifest = state.project.manifest;
  const plan = state.project.plans[0];
  const rows = [
    ["Patient", manifest.patient?.name || manifest.patient?.id || state.project.key],
    ["ID", manifest.patient?.id || ""],
    ["Image", manifest.primary_image || ""],
    ["Contours", String(state.project.contours.length)],
    ["Doses", String(state.project.doses.length)],
    ["Plan", plan?.path || ""],
  ];

  el.planSummary.replaceChildren();
  for (const [name, value] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = name;
    const dd = document.createElement("dd");
    dd.textContent = value;
    el.planSummary.append(dt, dd);
  }
}

function renderObjectList() {
  el.objectList.replaceChildren();
  for (const [index, dose] of state.project.doses.entries()) {
    el.objectList.append(objectCheckbox("dose", index, dose.id || dose.path, dose.path, state.selected.dose.has(index)));
  }
  for (const [index, contour] of state.project.contours.entries()) {
    el.objectList.append(
      objectCheckbox("contour", index, contour.name || contour.id || contour.path, contour.path, state.selected.contour.has(index)),
    );
  }
}

function objectCheckbox(kind, index, name, detail, checked) {
  const label = document.createElement("label");
  label.className = "object-row";

  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  input.addEventListener("change", async () => {
    const set = state.selected[kind];
    if (input.checked) {
      set.add(index);
    } else {
      set.delete(index);
    }
    await renderVolumes();
  });

  const text = document.createElement("span");
  const title = document.createElement("span");
  title.className = "object-name";
  title.textContent = name;
  const subtitle = document.createElement("span");
  subtitle.className = "object-kind";
  subtitle.textContent = `${kind} - ${detail}`;
  text.append(title, subtitle);

  label.append(input, text);
  return label;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json();
}

function patientLabel(patient) {
  const id = patient.patient?.id || patient.key;
  const name = patient.patient?.name;
  return name ? `${name} (${id})` : id;
}

main().catch((error) => {
  console.error(error);
  el.status.textContent = "Error";
  el.loadStatus.textContent = error.message || String(error);
});
