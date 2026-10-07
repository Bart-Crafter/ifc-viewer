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

  float viewDepth(vec2 uv) {
    float z = texture2D(tDepth, uv).x * 2.0 - 1.0;
    return (2.0 * cameraNear * cameraFar) / (cameraFar + cameraNear - z * (cameraFar - cameraNear));
  }

  void main() {
    vec3 n = texture2D(tNormal, vUv).xyz * 2.0 - 1.0;
    float d = viewDepth(vUv);
    vec2 ox = vec2(texel.x, 0.0);
    vec2 oy = vec2(0.0, texel.y);

    vec3 nl = texture2D(tNormal, vUv - ox).xyz * 2.0 - 1.0;
    vec3 nr = texture2D(tNormal, vUv + ox).xyz * 2.0 - 1.0;
    vec3 nd = texture2D(tNormal, vUv - oy).xyz * 2.0 - 1.0;
    vec3 nu = texture2D(tNormal, vUv + oy).xyz * 2.0 - 1.0;
    float crease = max(max(1.0 - dot(n, nl), 1.0 - dot(n, nr)), max(1.0 - dot(n, nd), 1.0 - dot(n, nu)));

    float dl = viewDepth(vUv - ox);
    float dr = viewDepth(vUv + ox);
    float dd = viewDepth(vUv - oy);
    float du = viewDepth(vUv + oy);
    // second difference: ~0 on a flat (even slanted) surface, large at a jump in distance
    float jump = (abs(dl + dr - 2.0 * d) + abs(dd + du - 2.0 * d)) / d;

    float edge = max(smoothstep(0.12, 0.45, crease), smoothstep(0.012, 0.05, jump));
    gl_FragColor = vec4(edgeColor, edge * strength);
  }
`;

export function createEdgePass(world) {
  const renderer = world.renderer.three;
  const scene = world.scene.three;
  const camera = world.camera.three;

  const normalMaterial = new THREE.MeshNormalMaterial();
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
      strength: { value: 0.6 },
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
    const px = Math.max(1, Math.round(renderer.getPixelRatio()));
    quadMaterial.uniforms.texel.value.set(px / size.x, px / size.y);
  }

  function render() {
    if (!enabled || size.x < 0) return;
    ensureTarget();

    // Leave out anything that shouldn't be outlined: not-yet-loaded placeholder boxes, lines (rulers), ground shadow plane.
    const hidden = [];
    scene.traverse((o) => {
      if (o.visible && ((o.isMesh && o.material?.isShaderMaterial) || o.isLine || o.isPoints || o.userData.noOutline)) {
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
