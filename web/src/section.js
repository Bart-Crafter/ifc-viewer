import * as THREE from "three";

// Section box: slice the model with six clipping planes (one pair per axis) so you can look inside it.
// Controlled with two-handle sliders in a panel (a bottom sheet on phones) because dragging planes in 3D fights with
// orbiting on a touch screen. The orange box in the view shows where the cut is. The box can be turned about the
// vertical axis, either with the Turn slider or by tapping a wall (it lines up with that face).
const AXES = [
  { index: 1, label: "Height" },
  { index: 0, label: "Along the box (left ↔ right)" },
  { index: 2, label: "Across the box (front ↔ back)" },
];
const MIN_GAP = 0.02; // the two handles of an axis never fully meet

function dualSlider({ label, onChange }) {
  const row = document.createElement("div");
  row.className = "dual";
  row.innerHTML = `
    <div class="dual-label">${label}</div>
    <div class="dual-track">
      <div class="dual-fill"></div>
      <div class="dual-thumb" data-which="lo" role="slider" tabindex="0" aria-label="${label} start"></div>
      <div class="dual-thumb" data-which="hi" role="slider" tabindex="0" aria-label="${label} end"></div>
    </div>`;
  const track = row.querySelector(".dual-track");
  const fill = row.querySelector(".dual-fill");
  const thumbs = { lo: row.querySelector('[data-which="lo"]'), hi: row.querySelector('[data-which="hi"]') };
  const value = { lo: 0, hi: 1 };

  function paint() {
    thumbs.lo.style.left = `${value.lo * 100}%`;
    thumbs.hi.style.left = `${value.hi * 100}%`;
    fill.style.left = `${value.lo * 100}%`;
    fill.style.width = `${(value.hi - value.lo) * 100}%`;
    thumbs.lo.setAttribute("aria-valuenow", Math.round(value.lo * 100));
    thumbs.hi.setAttribute("aria-valuenow", Math.round(value.hi * 100));
  }
  function move(which, ratio) {
    const r = Math.min(1, Math.max(0, ratio));
    if (which === "lo") value.lo = Math.min(r, value.hi - MIN_GAP);
    else value.hi = Math.max(r, value.lo + MIN_GAP);
    paint();
    onChange(value.lo, value.hi);
  }
  const ratioAt = (event) => {
    const rect = track.getBoundingClientRect();
    return (event.clientX - rect.left) / rect.width;
  };

  let dragging = null;
  track.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    const r = ratioAt(event);
    // grab the handle you touched, or the nearer one if you tapped the bar
    dragging = event.target.dataset?.which ?? (Math.abs(r - value.lo) <= Math.abs(r - value.hi) ? "lo" : "hi");
    try {
      track.setPointerCapture(event.pointerId); // keeps the drag going if the finger leaves the bar
    } catch {}
    move(dragging, r);
  });
  track.addEventListener("pointermove", (event) => dragging && move(dragging, ratioAt(event)));
  for (const type of ["pointerup", "pointercancel"]) track.addEventListener(type, () => (dragging = null));
  for (const which of ["lo", "hi"]) {
    thumbs[which].addEventListener("keydown", (event) => {
      const step = event.key === "ArrowLeft" || event.key === "ArrowDown" ? -0.02 : event.key === "ArrowRight" || event.key === "ArrowUp" ? 0.02 : 0;
      if (step) {
        event.preventDefault();
        move(which, value[which] + step);
      }
    });
  }
  paint();
  return {
    element: row,
    reset() {
      value.lo = 0;
      value.hi = 1;
      paint();
    },
  };
}

export function createSectionBox({ world, box, button, raycaster, notify = () => {} }) {
  const renderer = world.renderer.three;
  const scene = world.scene.three;
  const diagonal = box.getSize(new THREE.Vector3()).length();
  const pad = diagonal * 0.02;
  const center = box.getCenter(new THREE.Vector3());
  const corners = [];
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) corners.push(new THREE.Vector3(x, y, z));

  // The box is turned about the vertical axis through the model's centre. `placement` takes the box's own
  // frame to world space; `bounds` is the model's extent measured in the box's frame.
  let angle = 0; // radians
  const placement = new THREE.Matrix4();
  const bounds = new THREE.Box3();
  const size = new THREE.Vector3();

  function place() {
    placement
      .makeTranslation(center.x, center.y, center.z)
      .multiply(new THREE.Matrix4().makeRotationY(angle))
      .multiply(new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z));
    const inverse = placement.clone().invert();
    bounds.makeEmpty();
    for (const c of corners) bounds.expandByPoint(c.clone().applyMatrix4(inverse));
    bounds.expandByScalar(pad);
    bounds.getSize(size);
  }
  place();

  const range = { lo: [0, 0, 0], hi: [1, 1, 1] }; // fraction of the model's extent in the box's frame, per axis
  const frame = new THREE.Group(); // carries the outline in the box's turned frame
  frame.matrixAutoUpdate = false;
  const outline = new THREE.Box3Helper(new THREE.Box3(), 0xffa500);
  outline.material.depthTest = false; // visible through the model
  outline.renderOrder = 999;
  frame.add(outline);
  frame.visible = false;
  scene.add(frame);

  let enabled = false; // the Section button is on: the cut is applied (panel open or closed)
  let panelOpen = false;
  const isCut = () => range.lo.some((v) => v > 0.001) || range.hi.some((v) => v < 0.999);

  function apply() {
    const low = bounds.min.toArray().map((m, i) => m + size.getComponent(i) * range.lo[i]);
    const high = bounds.min.toArray().map((m, i) => m + size.getComponent(i) * range.hi[i]);
    const planes = [];
    for (let i = 0; i < 3; i++) {
      const unit = new THREE.Vector3().setComponent(i, 1);
      // planes are made in the box's own frame, then moved into place
      if (range.lo[i] > 0.001) planes.push(new THREE.Plane(unit.clone(), -low[i]).applyMatrix4(placement));
      if (range.hi[i] < 0.999) planes.push(new THREE.Plane(unit.clone().negate(), high[i]).applyMatrix4(placement));
    }
    renderer.clippingPlanes = enabled ? planes : []; // switched off: the whole model shows, settings are kept
    // a hair larger than the cut, so the outline isn't itself clipped away
    const grow = diagonal * 0.0015;
    outline.box.set(new THREE.Vector3(...low).addScalar(-grow), new THREE.Vector3(...high).addScalar(grow));
    frame.matrix.copy(placement);
    frame.matrixWorldNeedsUpdate = true;
    frame.visible = enabled && (panelOpen || isCut());
    button.classList.toggle("active", enabled);
    world.renderer.needsUpdate = true;
  }

  // ----- panel -----
  const panel = document.createElement("section");
  panel.className = "section-panel hidden";
  panel.setAttribute("aria-label", "Section box");
  panel.innerHTML = `
    <div class="section-head">
      <strong>Section box</strong>
      <div class="section-head-actions">
        <button type="button" class="secondary" data-reset>Reset</button>
        <button type="button" data-done>Done</button>
      </div>
    </div>
    <p class="section-help">Drag the handles to cut away part of the model. <em>Done</em> closes this panel and keeps the cut; <em>Reset</em> shows everything again.</p>
    <div class="section-sliders"></div>
    <div class="section-rotate">
      <div class="dual-label">Turn the box: <strong data-angle>0°</strong></div>
      <input type="range" min="-180" max="180" step="1" value="0" aria-label="Turn the section box" data-rotate />
      <div class="section-rotate-actions">
        <button type="button" class="secondary" data-align>Line up with a wall…</button>
        <button type="button" class="secondary" data-square>Square (0°)</button>
      </div>
    </div>`;
  const sliders = AXES.map((axis) => {
    const slider = dualSlider({
      label: axis.label,
      onChange: (lo, hi) => {
        range.lo[axis.index] = lo;
        range.hi[axis.index] = hi;
        apply();
      },
    });
    panel.querySelector(".section-sliders").append(slider.element);
    return slider;
  });
  document.body.append(panel);

  const rotateInput = panel.querySelector("[data-rotate]");
  const angleLabel = panel.querySelector("[data-angle]");
  const alignButton = panel.querySelector("[data-align]");

  function setAngleDegrees(degrees) {
    let d = ((((degrees + 180) % 360) + 360) % 360) - 180; // keep within -180..180
    d = Math.round(d * 10) / 10;
    angle = THREE.MathUtils.degToRad(d);
    rotateInput.value = String(Math.round(d));
    angleLabel.textContent = `${d}°`;
    place();
    apply();
  }
  rotateInput.addEventListener("input", () => setAngleDegrees(Number(rotateInput.value)));
  panel.querySelector("[data-square]").addEventListener("click", () => setAngleDegrees(0));

  // "Line up with a wall": the next tap on the model turns the box to face that wall.
  const canvas = renderer.domElement;
  let aligning = false;
  let tapStart = null;
  const stopAligning = () => {
    aligning = false;
    alignButton.classList.remove("active");
    alignButton.textContent = "Line up with a wall…";
  };
  alignButton.addEventListener("click", () => {
    if (aligning) return stopAligning();
    aligning = true;
    alignButton.classList.add("active");
    alignButton.textContent = "Tap a wall on the model… (cancel)";
  });
  canvas.addEventListener("pointerdown", (event) => {
    tapStart = aligning && event.isPrimary ? { x: event.clientX, y: event.clientY, t: performance.now() } : null;
  });
  canvas.addEventListener("pointerup", async (event) => {
    if (!aligning || !tapStart) return;
    const quick = performance.now() - tapStart.t < 280 && Math.hypot(event.clientX - tapStart.x, event.clientY - tapStart.y) < 8;
    tapStart = null;
    if (!quick) return; // that was an orbit/drag, not a tap
    const rect = canvas.getBoundingClientRect();
    const position = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    const hit = await raycaster.castRay({ position });
    const normal = hit?.normal;
    if (!normal) return notify("Tap on part of the model to line the box up with it.");
    const horizontal = Math.hypot(normal.x, normal.z);
    if (horizontal < 0.25) return notify("That face points up or down. Tap a wall or an upright face.");
    // turn the box so its "across" direction runs along the face's normal
    let degrees = THREE.MathUtils.radToDeg(Math.atan2(normal.x, normal.z));
    const square = Math.round(degrees / 90) * 90;
    if (Math.abs(degrees - square) < 1.5) degrees = square; // a wall that is square to the model's axes lands exactly square
    setAngleDegrees(degrees);
    stopAligning();
  });

  // On a phone the panel is a sheet over the bottom of the screen. Shift the picture up by half its height so the
  // model stays centred in the part you can still see, and put it back when the sheet closes.
  const phone = matchMedia("(max-width: 760px)");
  function liftView() {
    const camera = world.camera.three;
    if (panelOpen && phone.matches && canvas.clientHeight) {
      camera.setViewOffset(canvas.clientWidth, canvas.clientHeight, 0, panel.offsetHeight / 2, canvas.clientWidth, canvas.clientHeight);
    } else {
      camera.clearViewOffset();
    }
    world.renderer.needsUpdate = true;
  }
  new ResizeObserver(liftView).observe(panel);

  const showPanel = (on) => {
    panelOpen = on;
    panel.classList.toggle("hidden", !on);
    if (!on) stopAligning();
    apply();
    liftView();
  };

  // The Section button switches the section box on and off. Off shows the whole model; switching it on again brings
  // back the cut exactly as you left it. "Done" just tucks the panel away while the cut stays.
  button.addEventListener("click", () => {
    enabled = !enabled;
    if (!enabled) stopAligning();
    showPanel(enabled);
  });
  panel.querySelector("[data-reset]").addEventListener("click", () => {
    sliders.forEach((s) => s.reset());
    range.lo = [0, 0, 0];
    range.hi = [1, 1, 1];
    stopAligning();
    setAngleDegrees(0);
  });
  panel.querySelector("[data-done]").addEventListener("click", () => showPanel(false));

  return { showPanel };
}
