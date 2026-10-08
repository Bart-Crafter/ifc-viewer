import * as THREE from "three";
import * as OBC from "@thatopen/components";
import CameraControls from "camera-controls";
import fragmentsWorkerUrl from "@thatopen/fragments/worker?url";
import { api, setupRevisionBanner, toast } from "./common.js";
import { createEdgePass } from "./edges.js";
import { createSectionBox } from "./section.js";

const id = location.pathname.split("/").filter(Boolean).pop(); // file id from /view/ifc/:id
const HIGHLIGHT_STYLE = { color: new THREE.Color("orange"), opacity: 1, transparent: false, renderedFaces: 0 };
const RULER_COLOR = 0xffa500;

const nameEl = document.getElementById("model-name");
const revisionEl = document.getElementById("model-revision");
const statusEl = document.getElementById("viewer-status");
const container = document.getElementById("viewer-container");
const panel = document.getElementById("property-panel");
const panelContent = document.getElementById("property-content");
document.getElementById("close-panel").addEventListener("click", () => clearSelection());

const rulerButton = document.getElementById("measure-button");
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

// The property panel sits just under the header on phones; the header can be one or two rows tall.
function trackHeaderHeight() {
  const header = document.querySelector(".viewer-header");
  const set = () => document.documentElement.style.setProperty("--viewer-header-h", `${header.offsetHeight}px`);
  set();
  new ResizeObserver(set).observe(header);
}

let modelBox = null;

async function init() {
  trackHeaderHeight();
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
  if (info.type !== "ifc") return showProblem("Not a 3D model", "This file can't be opened in the 3D viewer.");

  nameEl.textContent = info.name;
  revisionEl.textContent = info.modified ? `Updated ${new Date(info.modified).toLocaleDateString()}` : "";
  document.title = `${info.name} — Crafter Engineering`;
  setupRevisionBanner(info, new URLSearchParams(location.search).get("scanned"));
  document.getElementById("back-link").href = `/p/${info.project.id}`;

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
  world.scene.three.background = new THREE.Color(0x01202f); // the site's deep navy

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
    if (box) {
      world.camera.controls.fitToBox(box, true);
      // "Reset view" puts the camera back to this opening view of the whole model.
      const reset = document.getElementById("reset-view-button");
      reset.classList.remove("hidden");
      reset.addEventListener("click", () => world.camera.controls.fitToBox(box, true));
      modelBox = box;
    }
  }

  statusEl.textContent = "";
  const raycasters = components.get(OBC.Raycasters);
  const raycaster = raycasters.get(world);
  setupPicking(world, raycaster);
  setupHint();
  if (modelBox) {
    const sectionButton = document.getElementById("section-button");
    sectionButton.classList.remove("hidden");
    createSectionBox({ world, box: modelBox, button: sectionButton, raycaster, notify: (message) => toast(message) });
  }
  setupRuler(world, raycaster);
  setupShading(model, world);
}

// ---------- shading styles ----------
// Shadows (default) = sun light with cast shadows. Shaded = the same lighting without shadows. Clay = one neutral colour.
async function setupShading(model, world) {
  if (!model) return;
  let mode = "shaded";
  const renderer = world.renderer.three;
  const scene = world.scene.three;

  // ----- shadows -----
  const sun = [...world.scene.directionalLights.values()][0];
  const ambient = [...world.scene.ambientLights.values()][0];
  const normal = { sun: sun?.intensity ?? 1, ambient: ambient?.intensity ?? 1, sunPosition: sun?.position.clone() };
  const box = await model.box;
  const center = box ? box.getCenter(new THREE.Vector3()) : new THREE.Vector3();
  const radius = box ? Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1) : 50;
  const shadowed = new WeakSet(); // meshes already set to cast/receive shadows
  let ground = null;

  const markMeshes = () => {
    model.object?.traverse((child) => {
      if (!child.isMesh || shadowed.has(child)) return;
      child.castShadow = true;
      child.receiveShadow = true;
      shadowed.add(child);
      for (const material of [].concat(child.material ?? [])) material.needsUpdate = true;
    });
  };
  model.onViewUpdated.add(() => {
    if (mode === "shadows") markMeshes();
  });

  // Lighting for every style: a directional "sun" from above and to one side, with the general fill turned down, so
  // faces facing different ways get clearly different brightness instead of one even grey. Shadows switch on top.
  function setLighting(withShadows) {
    renderer.shadowMap.enabled = withShadows;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    if (sun) {
      sun.position.copy(center).add(new THREE.Vector3(0.6, 1, 0.45).normalize().multiplyScalar(radius * 2));
      sun.target.position.copy(center);
      sun.target.updateMatrixWorld();
      sun.intensity = normal.sun * (withShadows ? 1.7 : 1.8); // without shadows, depth has to come from face shading
      sun.castShadow = withShadows;
      if (withShadows) {
        // fit the sun's shadow box to the model
        const cam = sun.shadow.camera;
        cam.left = cam.bottom = -radius * 1.1;
        cam.right = cam.top = radius * 1.1;
        cam.near = radius * 0.1;
        cam.far = radius * 4.5;
        cam.updateProjectionMatrix();
        const size = matchMedia("(pointer: coarse)").matches ? 2048 : 4096; // lighter on phones and tablets
        sun.shadow.mapSize.set(size, size);
        sun.shadow.bias = -0.0004;
        sun.shadow.normalBias = radius * 0.0004;
        sun.shadow.radius = 3; // softer edges
      }
    }
    if (ambient) ambient.intensity = normal.ambient * (withShadows ? 0.55 : 0.45);
    if (withShadows) {
      if (!ground && box) {
        // Catches the model's shadow, so the building sits on something.
        ground = new THREE.Mesh(new THREE.PlaneGeometry(radius * 8, radius * 8), new THREE.ShadowMaterial({ opacity: 0.18 }));
        ground.rotation.x = -Math.PI / 2;
        ground.position.set(center.x, box.min.y - 0.01, center.z);
        ground.receiveShadow = true;
        ground.userData.noOutline = true;
        scene.add(ground);
      }
      markMeshes();
    }
    if (ground) ground.visible = withShadows;
    model.object?.traverse((child) => {
      if (child.isMesh) for (const material of [].concat(child.material ?? [])) material.needsUpdate = true;
    });
  }

  async function apply(next) {
    mode = next;
    edgePass.setEnabled(EDGES_BY_STYLE[next] ?? false);
    clayModel = next === "clay" ? model : null;
    await model.resetOpacity(undefined);
    await model.resetColor(undefined);
    setLighting(next === "shadows");
    if (next === "clay") await model.setColor(undefined, CLAY_COLOR);
    await fragments.core.update(true);
    if (mode === "shadows") markMeshes(); // meshes created by the update above
    if (selected) {
      await fragments.highlight(HIGHLIGHT_STYLE, { [selected.modelId]: [selected.localId] });
      await syncClaySelection(null, selected);
    }
  }

  // Outlines come with the style: on for Shaded and Clay, off for Realistic.
  const edgePass = createEdgePass(world);
  const EDGES_BY_STYLE = { shadows: false, shaded: true, clay: true };

  shadingSelect.classList.remove("hidden");
  shadingSelect.addEventListener("change", () => apply(shadingSelect.value));
  // Every time a model is opened it starts in Shaded; the choice isn't remembered between visits.
  const saved = "shaded";
  shadingSelect.value = saved;
  apply(saved); // every style uses the contrast lighting, so this always runs
}


// ---------- selecting an element: press and hold ----------
// A plain click or drag never selects, so orbiting the model can't select things by accident. Holding still on an
// element for HOLD_MS (a third of a second) selects it, on a mouse and on a touch screen alike.
const HOLD_MS = 300;
const HOLD_MOVE_TOLERANCE = 8; // px the pointer may drift before it counts as a drag

async function clearSelection() {
  const previous = selected;
  panel.classList.add("hidden");
  if (!previous) return;
  selected = null;
  await fragments.resetHighlight({ [previous.modelId]: [previous.localId] });
  await syncClaySelection(previous, null);
  await fragments.core.update(true);
}

function setupPicking(world, raycaster) {
  const dom = world.renderer.three.domElement;
  let hold = null;

  function cancelHold() {
    if (!hold) return;
    clearTimeout(hold.timer);
    hold = null;
  }

  async function pickAt(clientX, clientY) {
    const rect = dom.getBoundingClientRect();
    const position = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
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
    hideHint(true); // they've worked it out
  }

  dom.addEventListener("pointerdown", (event) => {
    cancelHold();
    // only a single primary press counts (a second finger means pinch/pan, not select)
    if (rulerActive || !event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
    const start = { x: event.clientX, y: event.clientY };
    hold = {
      start,
      timer: setTimeout(() => {
        const { x, y } = start;
        cancelHold();
        navigator.vibrate?.(25);
        pickAt(x, y);
      }, HOLD_MS),
    };
  });
  dom.addEventListener("pointermove", (event) => {
    if (hold && Math.hypot(event.clientX - hold.start.x, event.clientY - hold.start.y) > HOLD_MOVE_TOLERANCE) cancelHold();
  });
  for (const type of ["pointerup", "pointercancel", "pointerleave", "wheel"]) dom.addEventListener(type, cancelHold, { passive: true });
  dom.addEventListener("contextmenu", (event) => event.preventDefault()); // long-press must not open the phone's menu
}

// ---------- controls hint ----------
const hintEl = document.getElementById("viewer-hint");
const touchDevice = matchMedia("(pointer: coarse)").matches;
const HINT_TEXT = touchDevice
  ? "Drag to rotate · Pinch to zoom · Two fingers to pan · <strong>Press and hold</strong> an element to select it"
  : "Drag to rotate · Scroll to zoom · Middle mouse to pan · <strong>Press and hold</strong> an element to select it";

function showHint() {
  hintEl.innerHTML = `<span>${HINT_TEXT}</span><button type="button" aria-label="Hide tip">&times;</button>`;
  hintEl.classList.remove("hidden");
  hintEl.querySelector("button").addEventListener("click", () => hideHint(true));
}
function hideHint(remember) {
  hintEl.classList.add("hidden");
  if (!remember) return;
  try {
    localStorage.setItem("viewer-hint-seen", "1");
  } catch {}
}
function setupHint() {
  document.getElementById("help-button").addEventListener("click", () => (hintEl.classList.contains("hidden") ? showHint() : hideHint(false)));
  let seen = false;
  try {
    seen = localStorage.getItem("viewer-hint-seen") === "1";
  } catch {}
  if (!seen) showHint();
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

  // A drag (orbiting, panning) must not place a ruler point: only a press that stays put and is released counts.
  let pressedAt = null;
  dom.addEventListener("pointerdown", (event) => {
    pressedAt = { x: event.clientX, y: event.clientY };
  });

  dom.addEventListener("click", async (event) => {
    if (!rulerActive) return;
    if (pressedAt && Math.hypot(event.clientX - pressedAt.x, event.clientY - pressedAt.y) > 5) return; // it was a drag
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

  rulerButton.addEventListener("click", async () => {
    rulerActive = !rulerActive;
    rulerButton.textContent = rulerActive ? "Stop ruler" : "📏 Ruler";
    rulerButton.classList.toggle("active", rulerActive);

    if (!rulerActive) {
      // Stopping the ruler also clears every dimension.
      cancelRulerPlacement();
      while (rulerMeasurements.length > 0) deleteMeasurement(rulerMeasurements[0]);
    } else if (selected) {
      const previous = selected;
      await fragments.resetHighlight({ [selected.modelId]: [selected.localId] });
      selected = null;
      panel.classList.add("hidden");
      await syncClaySelection(previous, null);
      await fragments.core.update(true);
    }
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
