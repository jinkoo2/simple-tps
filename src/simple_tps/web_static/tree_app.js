import React, { useMemo } from "react";
import { createRoot } from "react-dom/client";
import { Niivue } from "https://unpkg.com/@niivue/niivue@0.57.0/dist/index.js";

const h = React.createElement;
const LOG_PREFIX = "[simple-tps]";
const MULTIPLANAR_LAYOUT_GRID = 2;
const MULTIPLANAR_SHOW_RENDER_ALWAYS = 1;
const SLICE_TYPE_RENDER = 4;
const CONTOUR_RENDER_MODES = {
  inside: "Inside",
  border: "Border",
  inside_border: "Inside + Border",
};

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
  contourRenderModes: new Map(),
  busyCount: 0,
  nodeRegistry: new Map(),
  ui: {
    menuOpen: false,
    patientDialogOpen: false,
    patientSearch: "",
    selectedNodeId: null,
    expandedNodeIds: new Set(),
    propertyOpen: true,
  },
  nv: null,
};

const el = {
  sidebarRoot: document.getElementById("sidebar-root"),
  propertyRoot: document.getElementById("property-root"),
  viewerFrame: document.getElementById("viewer-frame"),
  viewerPlaceholder: document.getElementById("viewer-placeholder"),
  loadStatus: document.getElementById("load-status"),
  reloadButton: document.getElementById("reload-button"),
  propertyToggle: document.getElementById("property-toggle"),
};

let sidebarRoot = null;
let propertyRoot = null;

async function main() {
  sidebarRoot = createRoot(el.sidebarRoot);
  propertyRoot = createRoot(el.propertyRoot);

  state.nv = new Niivue({
    backColor: [0.02, 0.025, 0.03, 1],
    crosshairColor: [0.1, 0.85, 0.72, 1],
    heroImageFraction: 0,
    heroSliceType: SLICE_TYPE_RENDER,
    multiplanarEqualSize: true,
    multiplanarLayout: MULTIPLANAR_LAYOUT_GRID,
    multiplanarShowRender: MULTIPLANAR_SHOW_RENDER_ALWAYS,
    textHeight: 0.035,
  });
  await state.nv.attachTo("niivue-canvas");
  disableRenderVolumeRaycast();
  setViewerEmpty(true);

  el.reloadButton.addEventListener("click", () => reloadCurrentPatient());
  el.propertyToggle.addEventListener("click", () => {
    state.ui.propertyOpen = !state.ui.propertyOpen;
    renderApp();
  });

  state.config = await fetchJson("/api/config");
  await loadPatients();
  clearPatientState("Select a patient");
  renderApp();
}

async function loadPatients() {
  const payload = await fetchJson("/api/patients");
  state.patients = payload.patients;
}

async function reloadCurrentPatient() {
  const patientKey = state.project?.key;
  await loadPatients();
  if (patientKey) {
    await openPatient(patientKey);
  } else {
    renderApp();
  }
}

async function openPatient(patientKey) {
  clearPatientState("Loading patient");
  renderApp();

  state.project = await fetchJson(`/api/patients/${encodeURIComponent(patientKey)}/project`);
  initializeObjectSelection();
  state.ui.patientDialogOpen = false;
  state.ui.menuOpen = false;
  state.ui.patientSearch = "";
  state.ui.selectedNodeId = patientNodeId();
  restoreExpandedNodes();
  restoreContourRenderModes();
  el.loadStatus.textContent = "Patient loaded";
  renderApp();
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
  state.contourRenderModes = new Map();
  state.nodeRegistry = new Map();
  state.ui.expandedNodeIds = new Set();
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
  setViewerEmpty(true);
}

function initializeObjectSelection() {
  state.selectedImageId = null;
  state.loadedImageId = null;
  state.selectedPlanId = null;
  state.selected.dose = new Set();
  state.selected.contour = new Set();
}

async function selectImage(imageId) {
  debugLog("selectImage", { imageId });
  state.selectedImageId = imageId || null;
  state.selected.dose = new Set();
  state.selected.contour = new Set();
  state.overlayVolumes.dose = new Map();
  state.overlayVolumes.contour = new Map();
  renderApp();

  if (!state.selectedImageId) {
    state.loadedImageId = null;
    clearViewerVolumes();
    el.loadStatus.textContent = "Select an image";
    renderApp();
    return;
  }
  const image = selectedImage();
  debugLog("selectedImage resolved", imageSummary(image));
  await loadBaseImage(image);
  renderApp();
}

async function loadBaseImage(image) {
  debugLog("loadBaseImage requested", imageSummary(image));
  state.loadedImageId = null;
  if (!image?.url) {
    debugWarn("loadBaseImage skipped: image has no URL", imageSummary(image));
    state.selectedImageId = null;
    clearViewerVolumes();
    el.loadStatus.textContent = "No loadable image volume";
    return;
  }
  clearViewerVolumes();
  el.loadStatus.textContent = "Loading image";
  beginBusy();
  try {
    const descriptor = volumeDescriptor(image, "Image", "gray", 1);
    debugLog("NiiVue loadVolumes start", descriptor);
    await state.nv.loadVolumes([descriptor]);
    state.nv.setSliceType(state.nv.sliceTypeMultiplanar);
    state.loadedImageId = imageKey(image);
    setViewerEmpty(false);
    el.loadStatus.textContent = "Image loaded";
    debugLog("NiiVue loadVolumes success", {
      loadedImageId: state.loadedImageId,
      volumeCount: state.nv.volumes?.length,
      volumes: state.nv.volumes?.map((volume) => ({ id: volume.id, name: volume.name })),
    });
  } catch (error) {
    console.error(error);
    debugWarn("NiiVue loadVolumes failed", {
      image: imageSummary(image),
      error: error?.message || String(error),
    });
    state.selectedImageId = null;
    state.loadedImageId = null;
    clearViewerVolumes();
    el.loadStatus.textContent = `Load failed: ${error.message || error}`;
  } finally {
    endBusy();
  }
}

function setViewerEmpty(empty) {
  debugLog("setViewerEmpty", { empty });
  el.viewerFrame.classList.toggle("empty", empty);
  el.viewerPlaceholder.hidden = !empty;
}

function beginBusy() {
  state.busyCount += 1;
  document.body.classList.add("busy");
  debugLog("busy begin", { busyCount: state.busyCount });
}

function endBusy() {
  state.busyCount = Math.max(0, state.busyCount - 1);
  document.body.classList.toggle("busy", state.busyCount > 0);
  debugLog("busy end", { busyCount: state.busyCount });
}

async function selectPlan(planId) {
  state.selectedPlanId = planId || null;
  state.selected.dose = new Set(selectedPlanDoses().map(({ index }) => index));
  updateAllDoseVisibility();
  renderApp();
  if (state.selectedPlanId) {
    await loadSelectedPlanObjects();
  }
  updateAllDoseVisibility();
  renderApp();
}

async function loadSelectedPlanObjects() {
  const plan = selectedPlan();
  if (!plan) {
    return;
  }
  el.loadStatus.textContent = "Loading plan";
  beginBusy();
  try {
    await loadPlanDetails(plan);
    const planImage = imageForPlan(plan);
    if (planImage && imageKey(planImage) !== state.loadedImageId) {
      state.selectedImageId = imageKey(planImage);
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
  } finally {
    endBusy();
  }
}

async function loadPlanDetails(plan) {
  if (!plan.url || state.planDetails.has(plan.id)) {
    return state.planDetails.get(plan.id) || null;
  }
  const detail = await fetchJson(plan.url);
  state.planDetails.set(plan.id, detail);
  renderApp();
  return detail;
}

async function ensureOverlayVolume(kind, index, item, visible) {
  if (kind === "contour") {
    return ensureContourDisplay(index, item, visible);
  }
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
  if (!item?.url) {
    return null;
  }

  const descriptor = overlayDescriptor(kind, index, item, visible);
  beginBusy();
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
  } finally {
    endBusy();
  }
}

async function ensureContourDisplay(index, item, visible) {
  let overlay = state.overlayVolumes.contour.get(index) || {};
  state.overlayVolumes.contour.set(index, overlay);
  const mode = contourRenderMode(index);
  const needsFill = visible && contourModeShowsInside(mode);
  const needsBorder = visible && contourModeShowsBorder(mode);

  if (needsFill) {
    overlay.fill = await ensureContourVolumePart(index, item, "fill", item.url, contourOpacity(mode));
  }
  if (needsBorder) {
    overlay.border = await ensureContourVolumePart(index, item, "border", item.border_url, 1);
  }
  setContourPartOpacity(overlay.fill, needsFill ? contourOpacity(mode) : 0);
  setContourPartOpacity(overlay.border, needsBorder ? 1 : 0);

  if (visible) {
    await ensureContourSurface(index, item, overlay);
  }
  setContourSurfaceVisible(overlay, visible);
  return overlay.fill?.volume || overlay.border?.volume || null;
}

async function ensureContourVolumePart(index, item, part, url, opacity) {
  if (!url) {
    return null;
  }
  let overlay = state.overlayVolumes.contour.get(index) || {};
  if (overlay[part]?.volume) {
    setContourPartOpacity(overlay[part], opacity);
    return overlay[part];
  }
  if (overlay[part]?.loading) {
    const volume = await overlay[part].loading;
    overlay = state.overlayVolumes.contour.get(index) || overlay;
    setContourPartOpacity(overlay[part], opacity);
    return overlay[part] || { volume, opacity };
  }

  const descriptor = contourVolumeDescriptor(index, item, part, url, opacity);
  beginBusy();
  const loading = state.nv.addVolumeFromUrl(descriptor);
  overlay[part] = { loading, opacity };
  state.overlayVolumes.contour.set(index, overlay);
  try {
    const volume = await loading;
    overlay = state.overlayVolumes.contour.get(index) || overlay;
    overlay[part] = { volume, opacity };
    state.overlayVolumes.contour.set(index, overlay);
    return overlay[part];
  } finally {
    endBusy();
  }
}

async function ensureContourSurface(index, item, overlay) {
  if (!item.surface_url || overlay.surface?.mesh || overlay.surface?.loading) {
    if (overlay.surface?.loading) {
      await overlay.surface.loading;
    }
    return;
  }
  const color = hexToRgb(contourColor(item)) || hexToRgb("#e15759");
  const descriptor = {
    url: item.surface_url,
    name: `${volumeFileName(item, "Contour").replace(/\.[^.]+$/, "")}.surface.obj`,
    rgba255: [...color, 210],
    opacity: 0.82,
    visible: true,
  };
  beginBusy();
  debugLog("NiiVue addMeshFromUrl start", descriptor);
  const loading = state.nv.addMeshFromUrl(descriptor);
  overlay.surface = { loading };
  state.overlayVolumes.contour.set(index, overlay);
  try {
    const mesh = await loading;
    overlay.surface = { mesh, opacity: descriptor.opacity };
    state.overlayVolumes.contour.set(index, overlay);
    debugLog("NiiVue addMeshFromUrl success", { index, id: mesh?.id, name: descriptor.name });
  } catch (error) {
    overlay.surface = { error };
    debugWarn("NiiVue addMeshFromUrl failed", { index, error: String(error) });
  } finally {
    endBusy();
  }
}

async function setContourVisible(index, visible) {
  if (visible) {
    state.selected.contour.add(index);
  } else {
    state.selected.contour.delete(index);
  }
  try {
    await ensureOverlayVolume("contour", index, state.project.contours[index], visible);
  } catch (error) {
    console.error(error);
    el.loadStatus.textContent = `Load failed: ${error.message || error}`;
  }
  renderApp();
}

async function setDoseVisible(index, visible) {
  if (visible) {
    state.selected.dose.add(index);
  } else {
    state.selected.dose.delete(index);
  }
  try {
    await ensureOverlayVolume("dose", index, state.project.doses[index], visible);
  } catch (error) {
    console.error(error);
    el.loadStatus.textContent = `Load failed: ${error.message || error}`;
  }
  renderApp();
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

function setContourPartOpacity(part, opacity) {
  if (!part?.volume) {
    return;
  }
  part.opacity = opacity;
  const volumeIndex = state.nv.getVolumeIndexByID(part.volume.id);
  if (volumeIndex >= 0) {
    state.nv.setOpacity(volumeIndex, opacity);
  }
}

function setContourSurfaceVisible(overlay, visible) {
  const mesh = overlay?.surface?.mesh;
  if (!mesh) {
    return;
  }
  if (typeof state.nv.setMeshProperty === "function") {
    state.nv.setMeshProperty(mesh.id, "visible", visible);
  } else {
    mesh.visible = visible;
    state.nv.drawScene();
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

function contourVolumeDescriptor(index, item, part, url, opacity) {
  const color = contourColor(item);
  const colormap = contourColormap(index, color);
  const name = volumeFileName(item, "Contour");
  return {
    url,
    name: part === "border" ? name.replace(/\.[^.]+$/, ".border.mha") : name,
    colormap,
    opacity,
    visible: true,
  };
}

function overlayOpacity(kind) {
  return kind === "contour" ? 0.46 : 0.36;
}

function contourOpacity(mode) {
  return mode === "inside_border" ? 0.3 : overlayOpacity("contour");
}

function contourModeShowsInside(mode) {
  return mode === "inside" || mode === "inside_border";
}

function contourModeShowsBorder(mode) {
  return mode === "border" || mode === "inside_border";
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

function renderApp() {
  if (!sidebarRoot || !propertyRoot) {
    return;
  }
  sidebarRoot.render(h(SidebarApp));
  propertyRoot.render(h(PropertyPane));
  document.body.classList.toggle("property-hidden", !state.ui.propertyOpen);
  el.propertyToggle.textContent = state.ui.propertyOpen ? "Hide Properties" : "Show Properties";
}

function SidebarApp() {
  const tree = useMemo(() => buildTree(), [
    state.project,
    state.selectedImageId,
    state.loadedImageId,
    state.selectedPlanId,
    state.selected.dose.size,
    state.selected.contour.size,
    state.planDetails.size,
  ]);
  const visibleItems = visibleTreeItems(tree);

  return h(
    React.Fragment,
    null,
    h(
      "header",
      { className: "brand" },
      h(
        "div",
        { className: "brand-left" },
        h(
          "button",
          {
            type: "button",
            className: "icon-button hamburger-button",
            "aria-label": "Open menu",
            onClick: () => {
              state.ui.menuOpen = !state.ui.menuOpen;
              renderApp();
            },
          },
          h("span", { className: "hamburger-lines", "aria-hidden": "true" }),
        ),
        h("h1", null, "Simple TPS"),
      ),
      h("span", null, `${state.patients.length} patients`),
      state.ui.menuOpen && h(AppMenu),
    ),
    h(
      "section",
      { className: "tree-panel" },
      state.project
        ? h(TreeView, { items: tree, visibleItems })
        : h("div", { className: "empty-state" }, "Open a patient from the menu."),
    ),
    state.ui.patientDialogOpen && h(PatientSearchDialog),
  );
}

function AppMenu() {
  return h(
    "div",
    { className: "popup-menu" },
    h(
      "button",
      {
        type: "button",
        className: "menu-item",
        onClick: () => {
          state.ui.menuOpen = false;
          state.ui.patientDialogOpen = true;
          renderApp();
        },
      },
      h("span", null, "Patient"),
      h("span", { className: "menu-arrow" }, "Open"),
    ),
  );
}

function PatientSearchDialog() {
  const query = state.ui.patientSearch.trim().toLowerCase();
  const filtered = state.patients.filter((patient) => patientLabel(patient).toLowerCase().includes(query));
  return h(
    "div",
    { className: "dialog-backdrop" },
    h(
      "div",
      { className: "dialog" },
      h(
        "header",
        { className: "dialog-header" },
        h("h2", null, "Open Patient"),
        h(
          "button",
          {
            type: "button",
            className: "icon-button",
            "aria-label": "Close",
            onClick: () => {
              state.ui.patientDialogOpen = false;
              renderApp();
            },
          },
          "x",
        ),
      ),
      h("input", {
        className: "search-input",
        value: state.ui.patientSearch,
        placeholder: "Search by patient ID or name",
        autoFocus: true,
        onInput: (event) => {
          state.ui.patientSearch = event.currentTarget.value;
          renderApp();
        },
      }),
      h(
        "div",
        { className: "patient-results" },
        filtered.map((patient) =>
          h(
            "button",
            {
              key: patient.key,
              type: "button",
              className: "patient-result",
              onClick: () => openPatient(patient.key),
            },
            h("strong", null, patient.patient?.id || patient.key),
            h("span", null, patient.patient?.name || "Unnamed patient"),
          ),
        ),
        filtered.length === 0 && h("div", { className: "empty-state" }, "No matching patients"),
      ),
    ),
  );
}

function PropertyPane() {
  if (!state.ui.propertyOpen) {
    return null;
  }
  const nodeItem = state.ui.selectedNodeId ? state.nodeRegistry.get(state.ui.selectedNodeId) : null;
  const property = propertyForNode(nodeItem);
  return h(
    "div",
    { className: "property-content" },
    h(
      "header",
      { className: "property-header" },
      h("h2", null, "Properties"),
      h(
        "button",
        {
          type: "button",
          className: "icon-button",
          "aria-label": "Hide properties",
          onClick: () => {
            state.ui.propertyOpen = false;
            renderApp();
          },
        },
        "x",
      ),
    ),
    property
      ? h(
          React.Fragment,
          null,
          h("h3", null, property.title),
          h(
            "dl",
            { className: "property-list" },
            property.rows.map(([key, value]) => [
              h("dt", { key: `${key}-dt` }, key),
              h("dd", { key: `${key}-dd` }, formatValue(value)),
            ]),
          ),
          nodeItem?.type === "contour" && h(ContourPropertyControls, { contour: nodeItem.data, index: nodeItem.index }),
          property.json && h("pre", { className: "property-json" }, JSON.stringify(property.json, null, 2)),
        )
      : h("div", { className: "empty-state" }, "Select a tree node."),
  );
}

function ContourPropertyControls({ contour, index }) {
  const mode = contourRenderMode(index);
  return h(
    "section",
    { className: "property-controls" },
    h("h4", null, "Contour Rendering"),
    h(
      "div",
      { className: "segmented-control", role: "radiogroup", "aria-label": "Contour rendering mode" },
      Object.entries(CONTOUR_RENDER_MODES).map(([value, label]) =>
        h(
          "button",
          {
            key: value,
            type: "button",
            className: mode === value ? "active" : "",
            role: "radio",
            "aria-checked": mode === value,
            onClick: () => setContourRenderMode(index, value),
          },
          label,
        ),
      ),
    ),
    h(
      "p",
      { className: "property-help" },
      state.selected.contour.has(index)
        ? `${contour.name || contour.id || "Contour"} is visible in ${CONTOUR_RENDER_MODES[mode].toLowerCase()} mode.`
        : "Select the contour checkbox to display it.",
    ),
  );
}

function buildTree() {
  state.nodeRegistry = new Map();
  if (!state.project) {
    return [];
  }

  const patient = node(patientNodeId(), patientDisplayLabel(), "patient", { data: state.project.manifest.patient });
  const images = node("images", "Images", "category");
  const plans = node("plans", "Plans", "category");

  images.children = loadableImages().map((image) => {
    const imageItem = node(imageNodeId(image), imageLabel(image), "image", { data: image });
    const contourSet = node(`${imageItem.id}:contours`, "Contour Set", "contourSet", { image });
    contourSet.children = state.project.contours.map((contour, index) =>
      node(contourNodeId(index), contour.name || contour.id || contour.path, "contour", { data: contour, index }),
    );
    imageItem.children = [contourSet];
    return imageItem;
  });

  plans.children = state.project.plans.map((plan) => {
    const planItem = node(planNodeId(plan), planLabel(plan), "plan", { data: plan });
    const planImage = imageForPlanById(plan.id);
    const imageBranch = node(`${planItem.id}:image`, "Image", "category", { plan });
    if (planImage) {
      const planImageItem = node(`${planItem.id}:image:${imageKey(planImage)}`, imageLabel(planImage), "image", { data: planImage });
      const contourSet = node(`${planImageItem.id}:contours`, "Contour Set", "contourSet", { image: planImage, plan });
      contourSet.children = state.project.contours.map((contour, index) =>
        node(`${planItem.id}:contour:${index}`, contour.name || contour.id || contour.path, "contour", { data: contour, index }),
      );
      planImageItem.children = [contourSet];
      imageBranch.children = [planImageItem];
    }

    const beamBranch = node(`${planItem.id}:beams`, "Beams", "category", { plan });
    beamBranch.children = planBeams(plan).map((beam, index) =>
      node(`${planItem.id}:beam:${index}`, beam.name || beam.label || `Beam ${index + 1}`, "beam", { data: beam, index, plan }),
    );

    const doseBranch = node(`${planItem.id}:doses`, "Dose", "category", { plan });
    doseBranch.children = state.project.doses
      .map((dose, index) => ({ dose, index }))
      .filter(({ dose }) => dose.plan_id === plan.id)
      .map(({ dose, index }) => node(doseNodeId(index), dose.id || dose.path, "dose", { data: dose, index, plan }));

    planItem.children = [imageBranch, beamBranch, doseBranch];
    return planItem;
  });

  patient.children = [images, plans];
  registerNode(patient);
  return [patient];
}

function node(id, label, type, extra = {}) {
  return {
    id,
    label,
    type,
    children: [],
    ...extra,
  };
}

function registerNode(item) {
  state.nodeRegistry.set(item.id, item);
  item.children?.forEach(registerNode);
}

function TreeView({ items, visibleItems }) {
  const visible = new Set(visibleItems);
  return h("div", { className: "local-tree", role: "tree" }, items.map((item) => h(TreeNode, { key: item.id, item, visible, depth: 0 })));
}

function TreeNode({ item, visible, depth }) {
  const hasChildren = item.children?.length > 0;
  const expanded = state.ui.expandedNodeIds.has(item.id);
  const checked = visible.has(item.id);
  const selected = state.ui.selectedNodeId === item.id;
  return h(
    "div",
    { className: "local-tree-node", role: "treeitem", "aria-expanded": hasChildren ? expanded : undefined },
    h(
      "div",
      {
        className: `local-tree-row ${selected ? "selected" : ""}`,
        style: { paddingLeft: `${8 + depth * 18}px` },
        onClick: () => selectTreeNode(item.id),
      },
      h(
        "button",
        {
          type: "button",
          className: "tree-expander",
          disabled: !hasChildren,
          "aria-label": expanded ? "Collapse" : "Expand",
          onClick: (event) => {
            event.stopPropagation();
            toggleExpanded(item.id);
          },
        },
        hasChildren ? (expanded ? "v" : ">") : "",
      ),
      h("input", {
        type: "checkbox",
        checked,
        onChange: (event) => {
          event.stopPropagation();
          setNodeVisibility(item, event.currentTarget.checked);
        },
        onClick: (event) => event.stopPropagation(),
      }),
      h(
        "span",
        { className: `tree-label tree-label-${item.type}` },
        item.type === "contour" && h("span", { className: "object-swatch", style: { backgroundColor: contourColor(item.data) } }),
        item.label,
      ),
    ),
    hasChildren && expanded && h("div", { role: "group" }, item.children.map((child) => h(TreeNode, { key: child.id, item: child, visible, depth: depth + 1 }))),
  );
}

function toggleExpanded(itemId) {
  if (state.ui.expandedNodeIds.has(itemId)) {
    state.ui.expandedNodeIds.delete(itemId);
  } else {
    state.ui.expandedNodeIds.add(itemId);
  }
  persistExpandedNodes();
  renderApp();
}

function restoreExpandedNodes() {
  const key = expandedStorageKey();
  if (!key) {
    state.ui.expandedNodeIds = new Set();
    return;
  }
  try {
    const saved = JSON.parse(localStorage.getItem(key) || "null");
    state.ui.expandedNodeIds = Array.isArray(saved) ? new Set(saved) : new Set([patientNodeId()]);
  } catch (error) {
    state.ui.expandedNodeIds = new Set([patientNodeId()]);
  }
}

function persistExpandedNodes() {
  const key = expandedStorageKey();
  if (!key) {
    return;
  }
  localStorage.setItem(key, JSON.stringify([...state.ui.expandedNodeIds]));
}

function expandedStorageKey() {
  return state.project ? `simple-tps:tree-expanded:${state.project.key}` : null;
}

function contourRenderMode(index) {
  return state.contourRenderModes.get(index) || "inside_border";
}

async function setContourRenderMode(index, mode) {
  if (!CONTOUR_RENDER_MODES[mode]) {
    return;
  }
  state.contourRenderModes.set(index, mode);
  persistContourRenderModes();
  if (state.selected.contour.has(index)) {
    try {
      await ensureContourDisplay(index, state.project.contours[index], true);
    } catch (error) {
      console.error(error);
      el.loadStatus.textContent = `Load failed: ${error.message || error}`;
    }
  }
  renderApp();
}

function restoreContourRenderModes() {
  const key = contourModeStorageKey();
  if (!key) {
    state.contourRenderModes = new Map();
    return;
  }
  try {
    const saved = JSON.parse(localStorage.getItem(key) || "{}");
    state.contourRenderModes = new Map(
      Object.entries(saved)
        .map(([index, mode]) => [Number(index), mode])
        .filter(([index, mode]) => Number.isInteger(index) && Boolean(CONTOUR_RENDER_MODES[mode])),
    );
  } catch (error) {
    state.contourRenderModes = new Map();
  }
}

function persistContourRenderModes() {
  const key = contourModeStorageKey();
  if (!key) {
    return;
  }
  localStorage.setItem(key, JSON.stringify(Object.fromEntries(state.contourRenderModes)));
}

function contourModeStorageKey() {
  return state.project ? `simple-tps:contour-render-modes:${state.project.key}` : null;
}

function selectTreeNode(itemId) {
  state.ui.selectedNodeId = itemId;
  renderApp();
}

function visibleTreeItems(tree) {
  const ids = [];
  for (const item of flattenTree(tree)) {
    if (isNodeVisible(item)) {
      ids.push(item.id);
    }
  }
  return ids;
}

function isNodeVisible(item) {
  if (item.type === "image") {
    return imageKey(item.data) === state.selectedImageId;
  }
  if (item.type === "plan") {
    return item.data.id === state.selectedPlanId;
  }
  if (item.type === "contour") {
    return state.selected.contour.has(item.index);
  }
  if (item.type === "dose") {
    return state.selected.dose.has(item.index);
  }
  if (item.type === "category" || item.type === "contourSet") {
    const leaves = visibilityLeaves(item);
    return leaves.length > 0 && leaves.every(isNodeVisible);
  }
  return false;
}

function flattenTree(items) {
  const output = [];
  for (const item of items) {
    output.push(item);
    output.push(...flattenTree(item.children || []));
  }
  return output;
}

async function setNodeVisibility(item, visible) {
  if (item.type === "image") {
    if (visible) {
      await selectImage(imageKey(item.data));
    } else if (imageKey(item.data) === state.selectedImageId) {
      await selectImage("");
    }
    return;
  }
  if (item.type === "plan") {
    if (visible) {
      await selectPlan(item.data.id);
    } else if (item.data.id === state.selectedPlanId) {
      state.selectedPlanId = null;
      state.selected.dose = new Set();
      updateAllDoseVisibility();
      renderApp();
    }
    return;
  }
  if (item.type === "contour") {
    await setContourVisible(item.index, visible);
    return;
  }
  if (item.type === "dose") {
    await setDoseVisible(item.index, visible);
    return;
  }
  const leaves = visibilityLeaves(item);
  for (const leaf of leaves) {
    await setNodeVisibility(leaf, visible);
  }
}

function visibilityLeaves(item) {
  if (["image", "plan", "contour", "dose"].includes(item.type)) {
    return [item];
  }
  return (item.children || []).flatMap(visibilityLeaves);
}

function propertyForNode(nodeItem) {
  if (!nodeItem) {
    return null;
  }
  const baseRows = [["Type", nodeItem.type], ["ID", nodeItem.id]];
  if (nodeItem.type === "patient") {
    return { title: nodeItem.label, rows: baseRows, json: state.project.manifest.patient };
  }
  if (nodeItem.type === "image") {
    return { title: nodeItem.label, rows: objectRows(nodeItem.data), json: nodeItem.data.metadata_json || nodeItem.data };
  }
  if (nodeItem.type === "plan") {
    const detail = state.planDetails.get(nodeItem.data.id);
    return { title: nodeItem.label, rows: objectRows(nodeItem.data), json: detail || nodeItem.data.metadata_json || nodeItem.data };
  }
  if (nodeItem.type === "beam") {
    return { title: nodeItem.label, rows: baseRows, json: nodeItem.data };
  }
  if (nodeItem.type === "dose") {
    return { title: nodeItem.label, rows: objectRows(nodeItem.data), json: nodeItem.data.metadata_json || nodeItem.data };
  }
  if (nodeItem.type === "contour") {
    return { title: nodeItem.label, rows: objectRows(nodeItem.data), json: nodeItem.data.metadata_json || nodeItem.data };
  }
  return { title: nodeItem.label, rows: baseRows, json: null };
}

function objectRows(item) {
  return [
    ["ID", item.id || ""],
    ["Name", item.name || item.metadata_json?.name || item.metadata_json?.label || ""],
    ["Path", item.path || ""],
    ["Format", item.format || ""],
    ["Source", item.source || ""],
  ];
}

function formatValue(value) {
  if (value === null || value === undefined || value === "") {
    return "n/a";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

function selectedPlan() {
  if (!state.selectedPlanId || !state.project) {
    return null;
  }
  return state.project.plans.find((plan) => plan.id === state.selectedPlanId) || null;
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
  return imageForPlanById(plan?.id);
}

function imageForPlanById(planId) {
  if (!planId) {
    return null;
  }
  const plan = state.project.plans.find((candidate) => candidate.id === planId);
  const planDoses = state.project.doses.filter((dose) => dose.plan_id === planId);
  const referencedImagePath =
    plan?.metadata_json?.reference_image ||
    plan?.reference_image ||
    planDoses.find((dose) => dose.reference_image || dose.metadata_json?.reference_image)?.reference_image ||
    planDoses.find((dose) => dose.metadata_json?.reference_image)?.metadata_json?.reference_image ||
    state.project.manifest.primary_image;
  if (!referencedImagePath) {
    return null;
  }
  return loadableImages().find((image) => image.path === referencedImagePath || image.id === referencedImagePath) || null;
}

function selectedPlanDoses() {
  if (!state.selectedPlanId || !state.project) {
    return [];
  }
  return state.project.doses
    .map((dose, index) => ({ dose, index }))
    .filter(({ dose }) => dose.plan_id === state.selectedPlanId);
}

function planBeams(plan) {
  const detail = state.planDetails.get(plan.id);
  if (detail?.beams?.length) {
    return detail.beams;
  }
  const count = plan.metadata_json?.beam_count || 0;
  return Array.from({ length: count }, (_, index) => ({ name: `Beam ${index + 1}` }));
}

function patientNodeId() {
  return state.project ? `patient:${state.project.key}` : "patient";
}

function imageNodeId(image) {
  return `image:${imageKey(image)}`;
}

function planNodeId(plan) {
  return `plan:${plan.id}`;
}

function contourNodeId(index) {
  return `contour:${index}`;
}

function doseNodeId(index) {
  return `dose:${index}`;
}

function patientDisplayLabel() {
  const patient = state.project?.manifest.patient || {};
  return patient.id || patient.name || state.project?.key || "Patient";
}

function patientLabel(patient) {
  const id = patient.patient?.id || patient.key;
  const name = patient.patient?.name;
  return name ? `${name} (${id})` : id;
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

function imageSummary(image) {
  if (!image) {
    return null;
  }
  return {
    id: image.id,
    type: image.type,
    format: image.format,
    path: image.path,
    url: image.url,
    metadataUrl: image.metadata_url,
  };
}

function disableRenderVolumeRaycast() {
  if (!state.nv || typeof state.nv.drawImage3D !== "function") {
    return;
  }
  state.nv.drawImage3D = () => {};
  debugLog("Disabled 3D image ray-casting; render tile will show contour meshes only");
}

function debugLog(message, payload) {
  if (payload === undefined) {
    console.log(LOG_PREFIX, message);
  } else {
    console.log(LOG_PREFIX, message, payload);
  }
}

function debugWarn(message, payload) {
  if (payload === undefined) {
    console.warn(LOG_PREFIX, message);
  } else {
    console.warn(LOG_PREFIX, message, payload);
  }
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

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json();
}

main().catch((error) => {
  console.error(error);
  el.loadStatus.textContent = error.message || String(error);
});
