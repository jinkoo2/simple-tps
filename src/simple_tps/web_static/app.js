import { Niivue } from "https://unpkg.com/@niivue/niivue@0.57.0/dist/index.js";

const state = {
  config: null,
  patients: [],
  project: null,
  selectedPlanId: null,
  selected: {
    dose: new Set(),
    contour: new Set(),
  },
  overlayVolumes: {
    dose: new Map(),
    contour: new Map(),
  },
  nv: null,
};

const el = {
  status: document.getElementById("server-status"),
  patientSelect: document.getElementById("patient-select"),
  planSelect: document.getElementById("plan-select"),
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
  el.planSelect.addEventListener("change", () => selectPlan(el.planSelect.value));

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
  renderPlanSelect();
  renderProjectPanel();
  renderObjectList();
  await loadProjectVolumes();
}

function initializeObjectSelection() {
  state.selectedPlanId = null;
  state.selected.dose = new Set();
  state.selected.contour = new Set(state.project.contours.map((_, index) => index));
}

function renderPlanSelect() {
  el.planSelect.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select a plan";
  el.planSelect.append(placeholder);

  for (const plan of state.project.plans) {
    const option = document.createElement("option");
    option.value = plan.id;
    option.textContent = planLabel(plan);
    el.planSelect.append(option);
  }
  el.planSelect.disabled = state.project.plans.length === 0;
  el.planSelect.value = state.selectedPlanId || "";
}

function selectPlan(planId) {
  state.selectedPlanId = planId || null;
  state.selected.dose = new Set(selectedPlanDoses().map(({ index }) => index));
  renderProjectPanel();
  renderObjectList();
  updateAllDoseVisibility();
}

async function loadProjectVolumes() {
  const project = state.project;
  const base = project.volumes.find((volume) => volume.id === "ct" && volume.url) || project.volumes.find((volume) => volume.url);
  if (!base) {
    el.loadStatus.textContent = "No loadable image volume";
    return;
  }

  state.overlayVolumes.dose = new Map();
  state.overlayVolumes.contour = new Map();
  const volumes = [
    volumeDescriptor(base, "CT", "gray", 1),
  ];

  project.doses.forEach((dose, index) => {
    if (dose.url) {
      state.overlayVolumes.dose.set(index, {
        volumeIndex: volumes.length,
        opacity: 0.36,
      });
      volumes.push(volumeDescriptor(dose, "Dose", "hot", state.selected.dose.has(index) ? 0.36 : 0));
    }
  });

  project.contours.forEach((contour, index) => {
    if (contour.url) {
      const color = contourColor(contour);
      const colormap = contourColormap(index, color);
      state.overlayVolumes.contour.set(index, {
        volumeIndex: volumes.length,
        opacity: 0.46,
      });
      volumes.push(volumeDescriptor(contour, "Contour", colormap, state.selected.contour.has(index) ? 0.46 : 0));
    }
  });

  try {
    await state.nv.loadVolumes(volumes);
    state.nv.setSliceType(state.nv.sliceTypeMultiplanar);
    el.loadStatus.textContent = `${volumes.length} volume${volumes.length === 1 ? "" : "s"} loaded`;
  } catch (error) {
    console.error(error);
    el.loadStatus.textContent = `Load failed: ${error.message || error}`;
  }
}

function updateOverlayVisibility(kind, index, checked) {
  const overlay = state.overlayVolumes[kind].get(index);
  if (!overlay) {
    return;
  }
  state.nv.setOpacity(overlay.volumeIndex, checked ? overlay.opacity : 0);
}

function updateAllDoseVisibility() {
  for (const [index, overlay] of state.overlayVolumes.dose.entries()) {
    state.nv.setOpacity(overlay.volumeIndex, state.selected.dose.has(index) ? overlay.opacity : 0);
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

function contourColor(contour) {
  return contour.metadata_json?.color || contour.color || "#e15759";
}

function contourColormap(index, color) {
  const rgb = hexToRgb(color) || hexToRgb("#e15759");
  const name = `contour_${index}_${rgb.join("_")}`;
  state.nv.addColormap(name, {
    R: [0, rgb[0]],
    G: [0, rgb[1]],
    B: [0, rgb[2]],
    A: [0, 255],
    I: [0, 1],
  });
  return name;
}

function hexToRgb(value) {
  const match = String(value).trim().match(/^#?([0-9a-fA-F]{6})$/);
  if (!match) {
    return null;
  }
  const hex = match[1];
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
}

function renderProjectPanel() {
  const manifest = state.project.manifest;
  const plan = selectedPlan();
  const planDoseCount = selectedPlanDoses().length;
  const rows = [
    ["Patient", manifest.patient?.name || manifest.patient?.id || state.project.key],
    ["ID", manifest.patient?.id || ""],
    ["Image", manifest.primary_image || ""],
    ["Plans", String(state.project.plans.length)],
    ["Contours", String(state.project.contours.length)],
    ["Doses", String(planDoseCount)],
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
  for (const { dose, index } of selectedPlanDoses()) {
    el.objectList.append(objectCheckbox("dose", index, dose.id || dose.path, dose.path, state.selected.dose.has(index)));
  }
  for (const [index, contour] of state.project.contours.entries()) {
    el.objectList.append(
      objectCheckbox("contour", index, contour.name || contour.id || contour.path, contour.path, state.selected.contour.has(index)),
    );
  }
}

function selectedPlan() {
  if (!state.selectedPlanId) {
    return null;
  }
  return state.project.plans.find((plan) => plan.id === state.selectedPlanId) || state.project.plans[0] || null;
}

function selectedPlanDoses() {
  if (!state.selectedPlanId) {
    return [];
  }
  return state.project.doses
    .map((dose, index) => ({ dose, index }))
    .filter(({ dose }) => dose.plan_id === state.selectedPlanId);
}

function planLabel(plan) {
  return plan.metadata_json?.label || plan.metadata_json?.name || plan.id || plan.path;
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
    updateOverlayVisibility(kind, index, input.checked);
  });

  const text = document.createElement("span");
  if (kind === "contour") {
    const swatch = document.createElement("span");
    swatch.className = "object-swatch";
    swatch.style.backgroundColor = contourColor(state.project.contours[index]);
    text.append(swatch);
  }
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
