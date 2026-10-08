import * as THREE from "three";

// Screen-space outlines. Flat colour gives no definition where faces point the same way (a straight-on front view),
// so after each frame we draw a second, hidden pass of the scene (surface directions + distance) and darken the pixels
// where either one changes sharply: creases, and the outline of one element in front of another.
// Doing it per pixel, not per mesh, works however the model streams in, and costs one extra scene render per frame.
const VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const FRAGMENT = /* glsl */ `
  precision highp float;
  uniform sampler2D tNormal;
  uniform sampler2D tDepth;
  uniform vec2 texel;
  uniform float cameraNear;
  uniform float cameraFar;
  uniform vec3 edgeColor;
  uniform float strength;
  varying vec2 vUv;

  // 1 / distance from the camera. Unlike the distance itself this changes in a straight line across a flat
  // surface however steeply it is viewed, so flat surfaces never look like edges, and a step to another
  // element shows up as a clean jump whether it is near or far.
  float invDepth(vec2 uv) {
    float z = texture2D(tDepth, uv).x * 2.0 - 1.0;
    float d = (2.0 * cameraNear * cameraFar) / (cameraFar + cameraNear - z * (cameraFar - cameraNear));
    return 1.0 / d;
  }

  void main() {
    vec2 ox = vec2(texel.x, 0.0);
    vec2 oy = vec2(0.0, texel.y);
    vec3 n = texture2D(tNormal, vUv).xyz * 2.0 - 1.0;
    vec3 nr = texture2D(tNormal, vUv + ox).xyz * 2.0 - 1.0;
    vec3 nu = texture2D(tNormal, vUv + oy).xyz * 2.0 - 1.0;
    // creases between faces (only against the right/upper neighbour, so the line is one pixel wide)
    float crease = max(1.0 - dot(n, nr), 1.0 - dot(n, nu));

    float i = invDepth(vUv);
    float il = invDepth(vUv - ox);
    float ir = invDepth(vUv + ox);
    float id = invDepth(vUv - oy);
    float iu = invDepth(vUv + oy);
    // Second difference is ~0 on a flat surface. Beside a step it is negative on the nearer side only, so the
    // outline is drawn once, on the near element's edge, one pixel wide.
    float stepX = (ir + il - 2.0 * i) / i;
    float stepY = (iu + id - 2.0 * i) / i;
    float jump = max(-stepX, -stepY);

    float edge = max(smoothstep(0.25, 0.55, crease), smoothstep(0.004, 0.02, jump));
    gl_FragColor = vec4(edgeColor, edge * strength);
  }
`;

export function createEdgePass(world) {
  const renderer = world.renderer.three;
  const scene = world.scene.three;
  const camera = world.camera.three;

  const normalMaterial = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide }); // double-sided like the model, or back faces would leave holes
  const quadScene = new THREE.Scene();
  const quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quadMaterial = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      tNormal: { value: null },
      tDepth: { value: null },
      texel: { value: new THREE.Vector2() },
      cameraNear: { value: 1 },
      cameraFar: { value: 1000 },
      edgeColor: { value: new THREE.Color(0x0b0e12) },
      strength: { value: 0.55 },
    },
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), quadMaterial);
  quad.frustumCulled = false;
  quadScene.add(quad);

  let target = null;
  let enabled = false;
  const size = new THREE.Vector2();
  const clearColor = new THREE.Color();

  function ensureTarget() {
    renderer.getDrawingBufferSize(size);
    if (target && target.width === size.x && target.height === size.y) return;
    target?.depthTexture?.dispose();
    target?.dispose();
    target = new THREE.WebGLRenderTarget(size.x, size.y, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthTexture: new THREE.DepthTexture(size.x, size.y, THREE.UnsignedIntType),
    });
    quadMaterial.uniforms.texel.value.set(1 / size.x, 1 / size.y); // one device pixel: as thin as a line can be
  }

  function render() {
    if (!enabled || size.x < 0) return;
    ensureTarget();

    // Leave out anything that shouldn't be outlined: not-yet-loaded placeholder boxes, glass and other see-through
    // elements (drawn opaque here they would outline things that look empty), lines (rulers), the ground shadow plane.
    const hidden = [];
    scene.traverse((o) => {
      // (a mesh's material may be a single material or a list of them)
      const mats = o.isMesh ? [].concat(o.material ?? []) : [];
      const placeholder = mats.some((m) => m.isShaderMaterial);
      const seeThrough = mats.some((m) => m.transparent || m.opacity < 0.99);
      if (o.visible && (placeholder || seeThrough || o.isLine || o.isPoints || o.userData.noOutline)) {
        o.visible = false;
        hidden.push(o);
      }
    });
    const background = scene.background;
    scene.background = null;
    const previousAlpha = renderer.getClearAlpha();
    renderer.getClearColor(clearColor);
    const previousAutoClear = renderer.autoClear;
    const previousTarget = renderer.getRenderTarget();

    renderer.setRenderTarget(target);
    renderer.setClearColor(0x8080ff, 1); // "facing the viewer, far away"
    renderer.clear();
    scene.overrideMaterial = normalMaterial;
    renderer.render(scene, camera);
    scene.overrideMaterial = null;

    scene.background = background;
    for (const o of hidden) o.visible = true;

    quadMaterial.uniforms.tNormal.value = target.texture;
    quadMaterial.uniforms.tDepth.value = target.depthTexture;
    quadMaterial.uniforms.cameraNear.value = camera.near;
    quadMaterial.uniforms.cameraFar.value = camera.far;

    renderer.setRenderTarget(previousTarget);
    renderer.setClearColor(clearColor, previousAlpha);
    renderer.autoClear = false;
    renderer.render(quadScene, quadCamera);
    renderer.autoClear = previousAutoClear;
  }

  world.renderer.onAfterUpdate.add(render);
  size.set(0, 0);

  return {
    setEnabled(on) {
      enabled = on;
      world.renderer.needsUpdate = true;
    },
  };
}
