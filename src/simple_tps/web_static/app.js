import { Niivue } from "https://unpkg.com/@niivue/niivue@0.57.0/dist/index.js";

const state = {
  config: null,
  patients: [],
  project: null,
  selectedImageId: null,
  loadedImageId: null,
  selectedPlanId: null,
  selected: {
    dose: new Set(),
    contour: new Set(),
  },
  planDetails: new Map(),
  overlayVolumes: {
    dose: new Map(),
    contour: new Map(),
  },
  nv: null,
};

const el = {
  status: document.getElementById("server-status"),
  patientSelect: document.getElementById("patient-select"),
  imageSelect: document.getElementById("image-select"),
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
  el.imageSelect.addEventListener("change", () => selectImage(el.imageSelect.value));
  el.planSelect.addEventListener("change", () => selectPlan(el.planSelect.value));

  state.config = await fetchJson("/api/config");
  await loadPatients();
  clearPatientState("Select a patient");
}

async function loadPatients() {
  const payload = await fetchJson("/api/patients");
  state.patients = payload.patients;
  el.patientSelect.replaceChildren();

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select a patient";
  el.patientSelect.append(placeholder);

  for (const patient of state.patients) {
    const option = document.createElement("option");
    option.value = patient.key;
    option.textContent = patientLabel(patient);
    el.patientSelect.append(option);
  }

  el.status.textContent = `${state.patients.length} patient${state.patients.length === 1 ? "" : "s"}`;
  el.patientSelect.value = "";
}

async function loadSelectedPatient() {
  clearPatientState("Loading patient");
  const patientKey = el.patientSelect.value;
  if (!patientKey) {
    clearPatientState("Select a patient");
    return;
  }

  el.loadStatus.textContent = "Loading patient";
  state.project = await fetchJson(`/api/patients/${encodeURIComponent(patientKey)}/project`);
  initializeObjectSelection();
  renderImageSelect();
  renderPlanSelect();
  renderProjectPanel();
  renderObjectList();
  el.loadStatus.textContent = "Patient loaded";
}

function clearPatientState(statusText) {
  state.project = null;
  state.selectedImageId = null;
  state.loadedImageId = null;
  state.selectedPlanId = null;
  state.selected.dose = new Set();
  state.selected.contour = new Set();
  state.planDetails = new Map();
  state.overlayVolumes.dose = new Map();
  state.overlayVolumes.contour = new Map();

  el.imageSelect.replaceChildren();
  const imagePlaceholder = document.createElement("option");
  imagePlaceholder.value = "";
  imagePlaceholder.textContent = "Select an image";
  el.imageSelect.append(imagePlaceholder);
  el.imageSelect.value = "";
  el.imageSelect.disabled = true;

  el.planSelect.replaceChildren();
  const planPlaceholder = document.createElement("option");
  planPlaceholder.value = "";
  planPlaceholder.textContent = "Select a plan";
  el.planSelect.append(planPlaceholder);
  el.planSelect.value = "";
  el.planSelect.disabled = true;

  el.planSummary.replaceChildren();
  el.objectList.replaceChildren();
  el.loadStatus.textContent = statusText;
  clearViewerVolumes();
}

function clearViewerVolumes() {
  if (!state.nv) {
    return;
  }
  state.nv.volumes = [];
  state.nv.overlays = [];
  state.nv.meshes = [];
  state.nv.drawScene();
}

function initializeObjectSelection() {
  state.selectedImageId = null;
  state.loadedImageId = null;
  state.selectedPlanId = null;
  state.selected.dose = new Set();
  state.selected.contour = new Set();
}

function renderImageSelect() {
  el.imageSelect.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select an image";
  el.imageSelect.append(placeholder);

  for (const image of loadableImages()) {
    const option = document.createElement("option");
    option.value = image.id || image.path;
    option.textContent = imageLabel(image);
    el.imageSelect.append(option);
  }
  el.imageSelect.disabled = loadableImages().length === 0;
  el.imageSelect.value = state.selectedImageId || "";
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

async function selectPlan(planId) {
  state.selectedPlanId = planId || null;
  state.selected.dose = new Set(selectedPlanDoses().map(({ index }) => index));
  renderProjectPanel();
  renderObjectList();
  updateAllDoseVisibility();
  if (state.selectedPlanId) {
    await loadSelectedPlanObjects();
  }
  updateAllDoseVisibility();
}

async function selectImage(imageId) {
  state.selectedImageId = imageId || null;
  state.selected.dose = new Set();
  state.selected.contour = new Set();
  state.overlayVolumes.dose = new Map();
  state.overlayVolumes.contour = new Map();
  renderProjectPanel();
  renderObjectList();

  if (!state.selectedImageId) {
    state.loadedImageId = null;
    clearViewerVolumes();
    el.loadStatus.textContent = "Select an image";
    return;
  }
  await loadBaseImage(selectedImage());
}

async function loadBaseImage(image) {
  state.loadedImageId = null;
  if (!image?.url) {
    clearViewerVolumes();
    el.loadStatus.textContent = "No loadable image volume";
    return;
  }
  clearViewerVolumes();
  try {
    await state.nv.loadVolumes([volumeDescriptor(image, "Image", "gray", 1)]);
    state.nv.setSliceType(state.nv.sliceTypeMultiplanar);
    state.loadedImageId = imageKey(image);
    el.loadStatus.textContent = "Image loaded";
  } catch (error) {
    console.error(error);
    el.loadStatus.textContent = `Load failed: ${error.message || error}`;
  }
}

async function loadSelectedPlanObjects() {
  const plan = selectedPlan();
  if (!plan) {
    return;
  }
  el.loadStatus.textContent = "Loading plan";
  await loadPlanDetails(plan);
  const planImage = imageForPlan(plan);
  if (planImage && imageKey(planImage) !== state.loadedImageId) {
    state.selectedImageId = imageKey(planImage);
    el.imageSelect.value = state.selectedImageId;
    state.overlayVolumes.dose = new Map();
    state.overlayVolumes.contour = new Map();
    await loadBaseImage(planImage);
  }
  if (!state.loadedImageId) {
    el.loadStatus.textContent = "Select an image before loading plan objects";
    return;
  }
  await Promise.all(selectedPlanDoses().map(({ dose, index }) => ensureOverlayVolume("dose", index, dose, true)));
  el.loadStatus.textContent = "Plan loaded";
}

async function loadPlanDetails(plan) {
  if (!plan.url || state.planDetails.has(plan.id)) {
    return state.planDetails.get(plan.id) || null;
  }
  const detail = await fetchJson(plan.url);
  state.planDetails.set(plan.id, detail);
  return detail;
}

async function ensureOverlayVolume(kind, index, item, visible) {
  const overlay = state.overlayVolumes[kind].get(index);
  if (overlay?.volume) {
    setOverlayOpacity(overlay, visible);
    return overlay.volume;
  }
  if (!visible) {
    return null;
  }
  if (overlay?.loading) {
    const volume = await overlay.loading;
    setOverlayOpacity(state.overlayVolumes[kind].get(index), visible);
    return volume;
  }
  if (!item.url) {
    return null;
  }

  const descriptor = overlayDescriptor(kind, index, item, visible);
  const pending = state.nv.addVolumeFromUrl(descriptor);
  state.overlayVolumes[kind].set(index, {
    opacity: descriptor.opacity || overlayOpacity(kind),
    loading: pending,
  });
  try {
    const volume = await pending;
    state.overlayVolumes[kind].set(index, {
      volume,
      opacity: descriptor.opacity || overlayOpacity(kind),
    });
    return volume;
  } catch (error) {
    state.overlayVolumes[kind].delete(index);
    throw error;
  }
}

async function updateOverlayVisibility(kind, index, checked) {
  const item = kind === "dose" ? state.project.doses[index] : state.project.contours[index];
  try {
    await ensureOverlayVolume(kind, index, item, checked);
  } catch (error) {
    console.error(error);
    el.loadStatus.textContent = `Load failed: ${error.message || error}`;
  }
}

function updateAllDoseVisibility() {
  for (const [index, overlay] of state.overlayVolumes.dose.entries()) {
    setOverlayOpacity(overlay, state.selected.dose.has(index));
  }
}

function setOverlayOpacity(overlay, visible) {
  if (!overlay?.volume) {
    return;
  }
  const volumeIndex = state.nv.getVolumeIndexByID(overlay.volume.id);
  if (volumeIndex >= 0) {
    state.nv.setOpacity(volumeIndex, visible ? overlay.opacity : 0);
  }
}

function overlayDescriptor(kind, index, item, visible) {
  if (kind === "contour") {
    const color = contourColor(item);
    const colormap = contourColormap(index, color);
    return volumeDescriptor(item, "Contour", colormap, visible ? overlayOpacity(kind) : 0);
  }
  return volumeDescriptor(item, "Dose", "hot", visible ? overlayOpacity(kind) : 0);
}

function overlayOpacity(kind) {
  return kind === "contour" ? 0.46 : 0.36;
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
  const image = selectedImage();
  const rows = [
    ["Patient", manifest.patient?.name || manifest.patient?.id || state.project.key],
    ["ID", manifest.patient?.id || ""],
    ["Image", image?.path || ""],
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

function selectedImage() {
  if (!state.selectedImageId) {
    return null;
  }
  return loadableImages().find((image) => imageKey(image) === state.selectedImageId || image.path === state.selectedImageId) || null;
}

function loadableImages() {
  if (!state.project) {
    return [];
  }
  return state.project.volumes.filter((volume) => volume.url && volume.format !== "DICOM");
}

function imageForPlan(plan) {
  const planDoses = selectedPlanDoses();
  const referencedImagePath =
    plan?.metadata_json?.reference_image ||
    plan?.reference_image ||
    planDoses.find(({ dose }) => dose.reference_image || dose.metadata_json?.reference_image)?.dose?.reference_image ||
    planDoses.find(({ dose }) => dose.metadata_json?.reference_image)?.dose?.metadata_json?.reference_image ||
    state.project.manifest.primary_image;
  if (!referencedImagePath) {
    return null;
  }
  return loadableImages().find((image) => image.path === referencedImagePath || image.id === referencedImagePath) || null;
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

function imageLabel(image) {
  const type = image.type || image.metadata_json?.modality || "Image";
  return `${type} - ${imageKey(image)}`;
}

function imageKey(image) {
  return image.id || image.path;
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
