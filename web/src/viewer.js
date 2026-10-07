import * as THREE from "three";
import * as OBC from "@thatopen/components";
import CameraControls from "camera-controls";
import fragmentsWorkerUrl from "@thatopen/fragments/worker?url";
import { api } from "./common.js";

const id = location.pathname.split("/").filter(Boolean).pop(); // file id from /view/ifc/:id
const HIGHLIGHT_STYLE = { color: new THREE.Color("orange"), opacity: 1, transparent: false, renderedFaces: 0 };
const RULER_COLOR = 0xffa500;

const nameEl = document.getElementById("model-name");
const revisionEl = document.getElementById("model-revision");
const statusEl = document.getElementById("viewer-status");
const container = document.getElementById("viewer-container");
const panel = document.getElementById("property-panel");
const panelContent = document.getElementById("property-content");
document.getElementById("close-panel").addEventListener("click", () => panel.classList.add("hidden"));

const rulerButton = document.getElementById("measure-button");
const clearRulerButton = document.getElementById("clear-measure-button");
const shadingSelect = document.getElementById("shading-select");
const CLAY_COLOR = new THREE.Color(0xd9d9d9);
let clayModel = null; // the model, while the Clay shading style is active

// In Clay every element has an override colour, which the normal highlight can't beat, so the selected
// element is coloured explicitly (and put back to clay when deselected).
async function syncClaySelection(previous, next) {
  if (!clayModel) return;
  if (previous) await clayModel.setColor([previous.localId], CLAY_COLOR);
  if (next) await clayModel.setColor([next.localId], HIGHLIGHT_STYLE.color);
  await fragments.core.update(true);
}

let properties = {};
let fragments = null;
let selected = null; // { modelId, localId }
let rulerActive = false;
let rulerStart = null; // THREE.Vector3 | null
let rulerPreview = null; // { line, label, markerA, markerB } | null
let rulerGroup = null; // THREE.Group holding committed ruler lines
const rulerMeasurements = []; // { line, label, markerA, markerB, a, b }
const LONG_PRESS_MS = 550;

function showProblem(title, html) {
  nameEl.textContent = title;
  statusEl.innerHTML = html;
}

async function init() {
  let info;
  try {
    info = await api(`/api/files/${encodeURIComponent(id)}`);
  } catch (err) {
    if (err.message === "password_change_required") return void (location.href = "/");
    if (err.status === 401) showProblem("Sign in required", 'Please <a href="/">sign in</a> to open this model.');
    else if (err.status === 403) showProblem("No access", "Your account hasn't been given access to this project.");
    else showProblem("Model not found", "This file doesn't exist or was removed.");
    return;
  }
  if (info.folder !== "ifc") return showProblem("Not a 3D model", "This file can't be opened in the 3D viewer.");

  nameEl.textContent = info.name;
  revisionEl.textContent = info.modified ? `Updated ${new Date(info.modified).toLocaleDateString()}` : "";
  document.title = `${info.name} — Crafter Engineering`;
  document.getElementById("back-link").href = `/p/${info.project.id}`;
  setupDownload(info);

  if (info.status !== "ready") {
    return showProblem(
      info.name,
      info.status === "failed" ? "This model could not be converted for viewing." : "This model is still being prepared. Reload in a moment."
    );
  }

  statusEl.textContent = "Loading model…";

  const components = new OBC.Components();
  const worlds = components.get(OBC.Worlds);
  const world = worlds.create();

  world.scene = new OBC.SimpleScene(components);
  world.renderer = new OBC.SimpleRenderer(components, container);
  world.renderer.showLogo = false; // using our own branding instead
  world.camera = new OBC.SimpleCamera(components);
  // Mouse: left = orbit, middle = pan, wheel = zoom (right button does nothing).
  const buttons = world.camera.controls.mouseButtons;
  buttons.left = CameraControls.ACTION.ROTATE;
  buttons.middle = CameraControls.ACTION.TRUCK;
  buttons.right = CameraControls.ACTION.NONE;

  components.init();
  world.scene.setup();

  fragments = components.get(OBC.FragmentsManager);
  fragments.init(fragmentsWorkerUrl);

  world.camera.controls.addEventListener("rest", () => fragments.core.update(true));
  world.camera.controls.addEventListener("update", () => {
    fragments.core.update();
    updateRulerOverlays(world);
  });

  const [fragRes, propsRes] = await Promise.all([
    fetch(`/api/files/${encodeURIComponent(id)}/fragments`, { credentials: "same-origin" }),
    fetch(`/api/files/${encodeURIComponent(id)}/properties`, { credentials: "same-origin" }),
  ]);
  if (!fragRes.ok) throw new Error("Could not load converted geometry.");
  properties = propsRes.ok ? await propsRes.json() : {};

  const buffer = await fragRes.arrayBuffer();
  await fragments.core.load(buffer, { modelId: id });
  await fragments.core.update(true);

  const model = fragments.list.get(id);
  if (model?.object) world.scene.three.add(model.object);
  // Without this the model culls/loads tiles against the wrong view, so parts of the model
  // (e.g. whole sides of a scaffold) can fail to draw depending on where the camera is.
  model?.useCamera(world.camera.three);
  await fragments.core.update(true);
  if (model?.box) {
    const box = await model.box;
    if (box) world.camera.controls.fitToBox(box, true);
  }

  statusEl.textContent = "";
  const raycasters = components.get(OBC.Raycasters);
  const raycaster = raycasters.get(world);
  setupPicking(world, raycaster);
  setupRuler(world, raycaster);
  setupShading(model);
}

// ---------- shading styles ----------
// Shaded = as modelled. X-ray = see-through. Clay = one neutral colour (shape without distraction). Wireframe = edges only.
function setupShading(model) {
  if (!model) return;
  let mode = "shaded";

  // Tiles stream in as the camera moves, so wireframe is applied to meshes as they appear. Materials already
  // switched are remembered, so nothing is recompiled twice (recompiling every frame would freeze the page).
  const wired = new Set();
  const setWireframe = (on) => {
    model.object?.traverse((child) => {
      for (const material of [].concat(child.material ?? [])) {
        if (!("wireframe" in material)) continue;
        if (on && !wired.has(material)) {
          material.wireframe = true;
          material.needsUpdate = true;
          wired.add(material);
        } else if (!on && wired.has(material)) {
          material.wireframe = false;
          material.needsUpdate = true;
          wired.delete(material);
        }
      }
    });
  };
  model.onViewUpdated.add(() => {
    if (mode === "wireframe") setWireframe(true);
  });

  async function apply(next) {
    mode = next;
    clayModel = next === "clay" ? model : null;
    await model.resetOpacity(undefined);
    await model.resetColor(undefined);
    setWireframe(false);
    if (next === "xray") await model.setOpacity(undefined, 0.25);
    else if (next === "clay") await model.setColor(undefined, CLAY_COLOR);
    else if (next === "wireframe") setWireframe(true);
    await fragments.core.update(true);
    if (mode === "wireframe") setWireframe(true); // meshes created by the update above
    if (selected) {
      await fragments.highlight(HIGHLIGHT_STYLE, { [selected.modelId]: [selected.localId] });
      await syncClaySelection(null, selected);
    }
    try {
      localStorage.setItem("viewer-shading", next);
    } catch {}
  }

  shadingSelect.classList.remove("hidden");
  shadingSelect.addEventListener("change", () => apply(shadingSelect.value));
  let saved = "shaded";
  try {
    saved = localStorage.getItem("viewer-shading") || "shaded";
  } catch {}
  if (saved !== "shaded" && [...shadingSelect.options].some((o) => o.value === saved)) {
    shadingSelect.value = saved;
    apply(saved);
  }
}

function setupDownload(info) {
  // Viewer-level access gets no download button (the server also refuses the request).
  if (!info.canDownload) return;
  const button = document.getElementById("download-button");
  button.classList.remove("hidden");
  button.addEventListener("click", () => {
    location.href = `/api/files/${encodeURIComponent(id)}/download`;
  });
}

function setupPicking(world, raycaster) {
  const dom = world.renderer.three.domElement;

  dom.addEventListener("click", async (event) => {
    if (rulerActive) return;

    const rect = dom.getBoundingClientRect();
    const position = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );

    const result = await raycaster.castRay({ position });

    const previous = selected;
    if (selected) {
      await fragments.resetHighlight({ [selected.modelId]: [selected.localId] });
      selected = null;
    }

    if (!result || result.localId === undefined || result.localId === null || !result.fragments) {
      panel.classList.add("hidden");
      await syncClaySelection(previous, null);
      await fragments.core.update(true);
      return;
    }

    selected = { modelId: result.fragments.modelId, localId: result.localId };
    await fragments.highlight(HIGHLIGHT_STYLE, { [selected.modelId]: [selected.localId] });
    await syncClaySelection(previous, selected);
    await fragments.core.update(true);

    showProperties(result.localId);
  });
}

function setupRuler(world, raycaster) {
  const dom = world.renderer.three.domElement;
  rulerGroup = new THREE.Group();
  world.scene.three.add(rulerGroup);

  async function pickPoint(event) {
    const rect = dom.getBoundingClientRect();
    const position = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1
    );
    const result = await raycaster.castRay({ position });
    return result?.point ? result.point.clone() : null;
  }

  dom.addEventListener("pointermove", async (event) => {
    if (!rulerActive || !rulerStart) return;
    const point = await pickPoint(event);
    if (!point) return;
    updateLine(rulerPreview.line, rulerStart, point);
    positionLabel(rulerPreview.label, rulerStart, point, world);
    positionMarker(rulerPreview.markerB, point, world);
    await fragments.core.update(true);
  });

  dom.addEventListener("click", async (event) => {
    if (!rulerActive) return;
    const point = await pickPoint(event);
    if (!point) return;

    if (!rulerStart) {
      rulerStart = point;
      rulerPreview = {
        line: createLine(point, point),
        label: createLabel(),
        markerA: createMarker(),
        markerB: createMarker(),
      };
      rulerGroup.add(rulerPreview.line);
      positionMarker(rulerPreview.markerA, point, world);
      positionMarker(rulerPreview.markerB, point, world);
    } else {
      commitMeasurement(rulerStart, point, world);
      removePreview();
      rulerStart = null;
      await fragments.core.update(true);
    }
  });

  window.addEventListener("keydown", (event) => {
    if (!rulerActive || event.code !== "Escape") return;
    cancelRulerPlacement();
  });

  rulerButton.classList.remove("hidden");
  clearRulerButton.classList.remove("hidden");

  rulerButton.addEventListener("click", async () => {
    rulerActive = !rulerActive;
    rulerButton.textContent = rulerActive ? "Stop ruler" : "📏 Ruler";
    rulerButton.classList.toggle("active", rulerActive);

    if (!rulerActive) {
      cancelRulerPlacement();
    } else if (selected) {
      const previous = selected;
      await fragments.resetHighlight({ [selected.modelId]: [selected.localId] });
      selected = null;
      panel.classList.add("hidden");
      await syncClaySelection(previous, null);
      await fragments.core.update(true);
    }
  });

  clearRulerButton.addEventListener("click", () => {
    while (rulerMeasurements.length > 0) deleteMeasurement(rulerMeasurements[0]);
  });
}

function cancelRulerPlacement() {
  if (!rulerPreview) return;
  removePreview();
  rulerStart = null;
}

function removePreview() {
  rulerGroup.remove(rulerPreview.line);
  rulerPreview.line.geometry.dispose();
  rulerPreview.line.material.dispose();
  rulerPreview.label.remove();
  rulerPreview.markerA.remove();
  rulerPreview.markerB.remove();
  rulerPreview = null;
}

function createLine(a, b) {
  const geometry = new THREE.BufferGeometry().setFromPoints([a, b]);
  const material = new THREE.LineBasicMaterial({ color: RULER_COLOR, depthTest: false });
  const line = new THREE.Line(geometry, material);
  line.renderOrder = 999;
  return line;
}

function updateLine(line, a, b) {
  line.geometry.setFromPoints([a, b]);
  line.geometry.computeBoundingSphere();
}

function createLabel() {
  const label = document.createElement("div");
  label.className = "ruler-label";
  document.body.appendChild(label);
  return label;
}

function createMarker() {
  const marker = document.createElement("div");
  marker.className = "ruler-marker";
  document.body.appendChild(marker);
  return marker;
}

function projectToScreen(point, world) {
  const ndc = point.clone().project(world.camera.three);
  const rect = world.renderer.three.domElement.getBoundingClientRect();
  return {
    x: rect.left + (ndc.x * 0.5 + 0.5) * rect.width,
    y: rect.top + (-ndc.y * 0.5 + 0.5) * rect.height,
    offscreen: ndc.z > 1 || ndc.z < -1,
  };
}

function positionMarker(marker, point, world) {
  const { x, y, offscreen } = projectToScreen(point, world);
  marker.style.left = `${x}px`;
  marker.style.top = `${y}px`;
  marker.classList.toggle("hidden", offscreen);
}

function positionLabel(label, a, b, world) {
  const mid = a.clone().add(b).multiplyScalar(0.5);
  const { x, y, offscreen } = projectToScreen(mid, world);
  label.style.left = `${x}px`;
  label.style.top = `${y}px`;
  label.textContent = formatDistance(a.distanceTo(b));
  label.classList.toggle("hidden", offscreen);
}

function formatDistance(meters) {
  return `${meters.toFixed(2)} m`;
}

// Long-press (mouse or touch, via Pointer Events) on a measurement's label deletes it.
function attachLongPressDelete(label, onDelete) {
  let timer = null;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    label.classList.remove("holding");
  };
  label.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    label.classList.add("holding");
    timer = setTimeout(() => {
      clear();
      onDelete();
    }, LONG_PRESS_MS);
  });
  label.addEventListener("pointerup", clear);
  label.addEventListener("pointerleave", clear);
  label.addEventListener("pointercancel", clear);
  label.addEventListener("contextmenu", (event) => event.preventDefault());
}

function commitMeasurement(a, b, world) {
  const line = createLine(a, b);
  rulerGroup.add(line);
  const label = createLabel();
  label.classList.add("committed");
  const markerA = createMarker();
  const markerB = createMarker();
  positionLabel(label, a, b, world);
  positionMarker(markerA, a, world);
  positionMarker(markerB, b, world);

  const measurement = { a, b, line, label, markerA, markerB };
  attachLongPressDelete(label, () => deleteMeasurement(measurement));
  rulerMeasurements.push(measurement);
}

function deleteMeasurement(measurement) {
  const index = rulerMeasurements.indexOf(measurement);
  if (index === -1) return;
  rulerMeasurements.splice(index, 1);
  rulerGroup.remove(measurement.line);
  measurement.line.geometry.dispose();
  measurement.line.material.dispose();
  measurement.label.remove();
  measurement.markerA.remove();
  measurement.markerB.remove();
}

function updateRulerOverlays(world) {
  if (rulerPreview) {
    positionMarker(rulerPreview.markerA, rulerStart, world);
  }
  for (const m of rulerMeasurements) {
    positionLabel(m.label, m.a, m.b, world);
    positionMarker(m.markerA, m.a, world);
    positionMarker(m.markerB, m.b, world);
  }
}

function showProperties(localId) {
  const data = properties[localId];
  if (!data) {
    panelContent.innerHTML = `<h3>Element ${localId}</h3><p class="category">No property data extracted for this element.</p>`;
    panel.classList.remove("hidden");
    return;
  }

  let html = `<h3>${escapeHtml(data.name || `Element ${localId}`)}</h3><p class="category">${escapeHtml(data.category || "")}</p>`;

  const psetEntries = Object.entries(data.propertySets || {});
  const nonEmpty = psetEntries.filter(([, props]) => Object.keys(props).length > 0);

  if (nonEmpty.length === 0) {
    html += `<p class="category">No property values on this element.</p>`;
  }

  for (const [psetName, props] of nonEmpty) {
    html += `<div class="pset"><h4>${escapeHtml(psetName)}</h4><table>`;
    for (const [key, value] of Object.entries(props)) {
      html += `<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(formatValue(value))}</td></tr>`;
    }
    html += `</table></div>`;
  }

  panelContent.innerHTML = html;
  panel.classList.remove("hidden");
}

function formatValue(value) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

init().catch((err) => {
  console.error(err);
  statusEl.textContent = `Failed to load model: ${err.message}`;
});
