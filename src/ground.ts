import * as THREE from 'three';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';

const NOISE = /* glsl */ `
  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  float fbm(vec2 p) {
    float a = 0.5;
    float s = 0.0;
    for (int i = 0; i < 4; i++) {
      s += a * vnoise(p);
      p = p * 2.03 + 11.7;
      a *= 0.5;
    }
    return s;
  }
`;

const SHADER = {
  name: 'WetStreet',
  uniforms: {
    color: { value: null },
    tDiffuse: { value: null },
    textureMatrix: { value: null },
    time: { value: 0 },
    wetness: { value: 1 },
    fogColor: { value: new THREE.Color() },
    fogDensity: { value: 0 },
  },
  vertexShader: /* glsl */ `
    uniform mat4 textureMatrix;
    varying vec4 vUv;
    varying vec3 vWorld;
    void main() {
      vUv = textureMatrix * vec4(position, 1.0);
      vec4 world = modelMatrix * vec4(position, 1.0);
      vWorld = world.xyz;
      gl_Position = projectionMatrix * viewMatrix * world;
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float time;
    uniform float wetness;
    uniform vec3 fogColor;
    uniform float fogDensity;
    varying vec4 vUv;
    varying vec3 vWorld;
    ${NOISE}

    // Expanding rings where raindrops land.
    float ripples(vec2 p) {
      float s = 0.0;
      for (int i = 0; i < 2; i++) {
        float fi = float(i);
        vec2 q = p * (1.4 + fi * 1.1) + fi * 7.3;
        vec2 cell = floor(q);
        vec2 f = fract(q) - 0.5;
        float h = hash(cell + fi);
        float phase = fract(time * (0.8 + 0.6 * h) + h * 10.0);
        vec2 centre = (vec2(hash(cell + 1.7), hash(cell + 4.1)) - 0.5) * 0.5;
        float d = length(f - centre) - phase * 0.45;
        s += sin(d * 44.0) * smoothstep(0.07, 0.0, abs(d)) * (1.0 - phase);
      }
      return s;
    }

    void main() {
      vec2 p = vWorld.xz;
      vec3 toCam = cameraPosition - vWorld;
      float dist = length(toCam);
      vec3 V = toCam / dist;

      // Standing water collects in broad, irregular patches; the rest is damp asphalt.
      float puddle = smoothstep(0.46, 0.6, fbm(p * 0.11)) * wetness;
      float grit = vnoise(p * 38.0) * 0.6 + vnoise(p * 9.0) * 0.4;
      float near = 1.0 / (1.0 + dist * 0.03); // detail fades with distance instead of shimmering

      vec2 uv = vUv.xy / vUv.w;
      vec2 rough = (vec2(vnoise(p * 21.0), vnoise(p * 21.0 + 17.3)) - 0.5) * 0.022;
      vec2 wobble = mix(rough, vec2(ripples(p)) * 0.01, puddle) * near;

      // Wet asphalt smears reflections toward the viewer; puddles keep them sharp.
      float smear = mix(0.02, 0.003, puddle);
      vec3 refl = vec3(0.0);
      refl += texture2D(tDiffuse, uv + wobble).rgb * 0.32;
      refl += texture2D(tDiffuse, uv + wobble + vec2(0.0, smear)).rgb * 0.2;
      refl += texture2D(tDiffuse, uv + wobble - vec2(0.0, smear)).rgb * 0.2;
      refl += texture2D(tDiffuse, uv + wobble + vec2(0.0, smear * 2.4)).rgb * 0.14;
      refl += texture2D(tDiffuse, uv + wobble - vec2(0.0, smear * 2.4)).rgb * 0.14;

      float fresnel = pow(1.0 - max(V.y, 0.0), 4.0);
      float mirror = mix(0.1 + 0.45 * fresnel, 0.45 + 0.55 * fresnel, puddle) * mix(0.25, 1.0, wetness);
      mirror *= mix(0.75 + 0.5 * grit, 1.0, puddle);

      vec3 asphalt = vec3(0.03, 0.033, 0.037) * (0.6 + 0.8 * grit) * (1.0 - 0.55 * puddle);
      vec3 col = asphalt + refl * mirror;

      float fog = 1.0 - exp(-fogDensity * fogDensity * dist * dist);
      col = mix(col, fogColor, fog);
      gl_FragColor = vec4(col, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
};

/** Rain-slicked road surface that mirrors the city, with puddles and raindrop rings. */
export function createGround(scene: THREE.Scene, width: number, height: number) {
  const mirror = new Reflector(new THREE.PlaneGeometry(1500, 1500), {
    textureWidth: width,
    textureHeight: height,
    clipBias: 0.003,
    shader: SHADER,
  });
  mirror.rotation.x = -Math.PI / 2;
  mirror.position.y = 0.012; // just above the road slabs, below the kerb and lane lines
  scene.add(mirror);
  const uniforms = (mirror.material as THREE.ShaderMaterial).uniforms;

  return {
    setSize(w: number, h: number) {
      mirror.getRenderTarget().setSize(w, h);
    },
    /** `wetness` 0 is a dry street, 1 is normal rain. */
    update(cam: THREE.Vector3, dt: number, fog: THREE.FogExp2, wetness: number) {
      mirror.position.x = cam.x;
      mirror.position.z = cam.z;
      uniforms.time.value += dt;
      uniforms.wetness.value = Math.min(1, wetness);
      uniforms.fogColor.value.copy(fog.color);
      uniforms.fogDensity.value = fog.density;
    },
  };
}
