import * as THREE from "three";

// Section box: slice the model with six clipping planes (one pair per axis) so you can look inside it.
// Controlled with two-handle sliders in a panel (a bottom sheet on phones) because dragging planes in 3D fights with
// orbiting on a touch screen; the orange box in the view shows where the cut is.
const AXES = [
  { index: 1, label: "Height", low: "bottom", high: "top" },
  { index: 0, label: "Left ↔ Right", low: "left", high: "right" },
  { index: 2, label: "Front ↔ Back", low: "front", high: "back" },
];
const MIN_GAP = 0.02; // the two handles of an axis never fully meet

function dualSlider({ label, onChange }) {
  const row = document.createElement("div");
  row.className = "dual";
  row.innerHTML = `
    <div class="dual-label">${label}</div>
    <div class="dual-track" touch-action="none">
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
    track.setPointerCapture(event.pointerId);
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

export function createSectionBox({ world, box, button }) {
  const renderer = world.renderer.three;
  const scene = world.scene.three;
  const diagonal = box.getSize(new THREE.Vector3()).length();
  const bounds = box.clone().expandByScalar(diagonal * 0.02);
  const size = bounds.getSize(new THREE.Vector3());

  const range = { lo: [0, 0, 0], hi: [1, 1, 1] }; // fraction of the model's extent, per axis
  const outline = new THREE.Box3Helper(new THREE.Box3(), 0xffa500);
  outline.material.depthTest = false; // visible through the model
  outline.renderOrder = 999;
  outline.visible = false;
  scene.add(outline);

  let panelOpen = false;
  const isCut = () => range.lo.some((v) => v > 0.001) || range.hi.some((v) => v < 0.999);

  function apply() {
    const low = bounds.min.toArray().map((m, i) => m + size.getComponent(i) * range.lo[i]);
    const high = bounds.min.toArray().map((m, i) => m + size.getComponent(i) * range.hi[i]);
    const planes = [];
    for (let i = 0; i < 3; i++) {
      const unit = new THREE.Vector3().setComponent(i, 1);
      if (range.lo[i] > 0.001) planes.push(new THREE.Plane(unit.clone(), -low[i])); // keeps everything above the low cut
      if (range.hi[i] < 0.999) planes.push(new THREE.Plane(unit.clone().negate(), high[i])); // keeps everything below the high cut
    }
    renderer.clippingPlanes = planes;
    // a hair larger than the cut, so the outline isn't itself clipped away
    const grow = diagonal * 0.0015;
    outline.box.set(new THREE.Vector3(...low).addScalar(-grow), new THREE.Vector3(...high).addScalar(grow));
    outline.visible = panelOpen || isCut();
    button.classList.toggle("active", panelOpen || isCut());
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
    <div class="section-sliders"></div>`;
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

  // On a phone the panel is a sheet over the bottom of the screen. Shift the picture up by half its height so the
  // model stays centred in the part you can still see, and put it back when the sheet closes.
  const phone = matchMedia("(max-width: 760px)");
  function liftView() {
    const camera = world.camera.three;
    const el = renderer.domElement;
    if (panelOpen && phone.matches && el.clientHeight) {
      camera.setViewOffset(el.clientWidth, el.clientHeight, 0, panel.offsetHeight / 2, el.clientWidth, el.clientHeight);
    } else {
      camera.clearViewOffset();
    }
    world.renderer.needsUpdate = true;
  }
  new ResizeObserver(liftView).observe(panel);

  const showPanel = (on) => {
    panelOpen = on;
    panel.classList.toggle("hidden", !on);
    apply();
    liftView();
  };

  // The button opens/closes the panel. The cut stays in place when the panel is closed (the button stays lit); Reset removes it.
  button.addEventListener("click", () => showPanel(!panelOpen));
  panel.querySelector("[data-reset]").addEventListener("click", () => {
    sliders.forEach((s) => s.reset());
    range.lo = [0, 0, 0];
    range.hi = [1, 1, 1];
    apply();
  });
  panel.querySelector("[data-done]").addEventListener("click", () => showPanel(false));

  return { showPanel };
}
