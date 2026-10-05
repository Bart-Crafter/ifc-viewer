import * as THREE from "three";
import * as OBC from "@thatopen/components";
import CameraControls from "camera-controls";
import fragmentsWorkerUrl from "@thatopen/fragments/worker?url";

const id = location.pathname.split("/").filter(Boolean).pop();
const PASSWORD_KEY = `ifc-viewer-model-pw-${id}`;
const HIGHLIGHT_STYLE = { color: new THREE.Color("orange"), opacity: 1, transparent: false, renderedFaces: 0 };
const RULER_COLOR = 0xffa500;

const nameEl = document.getElementById("model-name");
const revisionEl = document.getElementById("model-revision");
const statusEl = document.getElementById("viewer-status");
const container = document.getElementById("viewer-container");
const panel = document.getElementById("property-panel");
const panelContent = document.getElementById("property-content");
document.getElementById("close-panel").addEventListener("click", () => panel.classList.add("hidden"));

const qrModal = document.getElementById("qr-modal");
const qrImage = document.getElementById("qr-image");
const qrUrl = document.getElementById("qr-url");
document.getElementById("qr-button").addEventListener("click", () => {
  qrImage.src = `/api/models/${id}/qr.png`;
  qrUrl.textContent = `${location.origin}/model/${id}`;
  qrModal.classList.remove("hidden");
});
document.getElementById("close-qr").addEventListener("click", () => qrModal.classList.add("hidden"));

const rulerButton = document.getElementById("measure-button");
const clearRulerButton = document.getElementById("clear-measure-button");

const passwordGate = document.getElementById("password-gate");
const passwordGateTitle = document.getElementById("password-gate-title");
const passwordGateForm = document.getElementById("password-gate-form");
const passwordGateInput = document.getElementById("password-gate-input");
const passwordGateError = document.getElementById("password-gate-error");

let properties = {};
let modelPassword = null;
let fragments = null;
let selected = null; // { modelId, localId }
let rulerActive = false;
let rulerStart = null; // THREE.Vector3 | null
let rulerPreview = null; // { line, label, markerA, markerB } | null
let rulerGroup = null; // THREE.Group holding committed ruler lines
const rulerMeasurements = []; // { line, label, markerA, markerB, a, b }
const LONG_PRESS_MS = 550;

async function verifyModelPassword(password) {
  const res = await fetch(`/api/models/${id}/verify-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  return res.ok;
}

function withPasswordHeader() {
  return modelPassword ? { "X-Model-Password": modelPassword } : {};
}

async function ensureUnlocked(meta) {
  if (!meta.passwordProtected) return;

  const stored = localStorage.getItem(PASSWORD_KEY);
  if (stored && (await verifyModelPassword(stored))) {
    modelPassword = stored;
    return;
  }

  passwordGateTitle.textContent = `"${meta.name}" is password protected`;
  passwordGateError.textContent = "";
  passwordGateInput.value = "";
  passwordGate.classList.remove("hidden");
  passwordGateInput.focus();

  await new Promise((resolve) => {
    passwordGateForm.onsubmit = async (event) => {
      event.preventDefault();
      const entered = passwordGateInput.value;
      passwordGateError.textContent = "Checking…";
      if (await verifyModelPassword(entered)) {
        localStorage.setItem(PASSWORD_KEY, entered);
        modelPassword = entered;
        passwordGate.classList.add("hidden");
        resolve();
      } else {
        passwordGateError.textContent = "Incorrect password.";
      }
    };
  });
}

async function init() {
  const metaRes = await fetch(`/api/models/${id}`);
  if (!metaRes.ok) {
    nameEl.textContent = "Model not found";
    statusEl.textContent = "This model ID does not exist or was removed.";
    return;
  }
  const meta = await metaRes.json();
  nameEl.textContent = meta.name;
  revisionEl.textContent = `Revision ${meta.revision}`;
  document.title = `${meta.name} — IFC Viewer`;

  await ensureUnlocked(meta);
  setupDownload(meta);

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
    fetch(`/api/models/${id}/fragments`, { headers: withPasswordHeader() }),
    fetch(`/api/models/${id}/properties`, { headers: withPasswordHeader() }),
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
}

function setupDownload(meta) {
  // Only models uploaded since downloads were added have the original IFC stored.
  if (!meta.hasOriginal) return;
  const button = document.getElementById("download-button");
  button.classList.remove("hidden");
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const res = await fetch(`/api/models/${id}/download`, { headers: withPasswordHeader() });
      if (!res.ok) throw new Error(res.statusText);
      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = meta.originalFilename || `${meta.name}.ifc`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert(`Couldn't download the IFC file: ${err.message}`);
    } finally {
      button.disabled = false;
    }
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

    if (selected) {
      await fragments.resetHighlight({ [selected.modelId]: [selected.localId] });
      selected = null;
    }

    if (!result || result.localId === undefined || result.localId === null || !result.fragments) {
      panel.classList.add("hidden");
      await fragments.core.update(true);
      return;
    }

    selected = { modelId: result.fragments.modelId, localId: result.localId };
    await fragments.highlight(HIGHLIGHT_STYLE, { [selected.modelId]: [selected.localId] });
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
      await fragments.resetHighlight({ [selected.modelId]: [selected.localId] });
      selected = null;
      panel.classList.add("hidden");
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
