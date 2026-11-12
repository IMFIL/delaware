import * as THREE from 'three';

/** Smog colour at the horizon; the scene fog uses the same value. */
export const HAZE = 0x22323c;
const ZENITH = 0x04070b;
const GROUND = 0x0a0e12;
const CITY_GLOW = 0xff7a2a;

const LIGHT_DIR = new THREE.Vector3(0.45, 0.72, 0.35).normalize();
const GLOW_DIR = new THREE.Vector3(-0.6, 0, -0.8).normalize();

const OUTPUT = `
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
`;

function body(radius: number, colA: number, colB: number, bands: number, dim: number) {
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    fog: false,
    uniforms: {
      lightDir: { value: LIGHT_DIR },
      colA: { value: new THREE.Color(colA) },
      colB: { value: new THREE.Color(colB) },
      bands: { value: bands / radius },
      dim: { value: dim },
    },
    vertexShader: `
      varying vec3 vN;
      varying vec3 vP;
      void main() {
        vN = normalize(mat3(modelMatrix) * normal);
        vP = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 lightDir, colA, colB;
      uniform float bands, dim;
      varying vec3 vN;
      varying vec3 vP;
      void main() {
        float lit = smoothstep(-0.15, 0.5, dot(normalize(vN), lightDir));
        float t = vP.y * bands;
        float band = 0.5 + 0.5 * sin(t + sin(t * 0.37) * 2.0);
        vec3 c = mix(colA, colB, band) * (0.35 + 0.9 * lit);
        gl_FragColor = vec4(c, (lit * 0.9 + 0.1) * dim);
        ${OUTPUT}
      }`,
  });
  return new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 32), mat);
}

export function createSky(scene: THREE.Scene, renderer: THREE.WebGLRenderer) {
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      haze: { value: new THREE.Color(HAZE) },
      zenith: { value: new THREE.Color(ZENITH) },
      ground: { value: new THREE.Color(GROUND) },
      cityGlow: { value: new THREE.Color(CITY_GLOW) },
      glowDir: { value: GLOW_DIR },
    },
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 haze, zenith, ground, cityGlow, glowDir;
      varying vec3 vDir;
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
        for (int i = 0; i < 5; i++) {
          s += a * vnoise(p);
          p = p * 2.02 + 9.1;
          a *= 0.5;
        }
        return s;
      }
      void main() {
        vec3 d = normalize(vDir);
        vec3 col = d.y > 0.0
          ? mix(haze, zenith, pow(d.y, 0.45))
          : mix(haze, ground, smoothstep(0.0, 0.25, -d.y));
        // Sodium-orange light pollution low on one side of the sky.
        float toward = max(dot(normalize(d.xz + 1e-5), glowDir.xz), 0.0);
        col += cityGlow * toward * toward * exp(-abs(d.y) * 5.0) * 0.16;
        // A low smog deck, lit from underneath by the city: brighter and warmer toward the horizon.
        if (d.y > 0.0) {
          vec2 sheet = d.xz / (d.y + 0.12);
          float cloud = smoothstep(0.38, 0.75, fbm(sheet * 0.9));
          float low = exp(-d.y * 3.0);
          vec3 lit = mix(vec3(0.05, 0.06, 0.07), cityGlow * 0.22 + haze * 0.5, low);
          lit += cityGlow * 0.12 * toward * toward * low;
          col = mix(col, lit, cloud * (0.35 + 0.5 * low));
        }
        gl_FragColor = vec4(col, 1.0);
        ${OUTPUT}
      }`,
  });
  const dome = new THREE.SphereGeometry(2000, 32, 16);

  // Sky-only scene for reflections on glass and wet surfaces.
  const envScene = new THREE.Scene();
  envScene.add(new THREE.Mesh(dome, skyMat));
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(envScene, 0, 1, 3000).texture;
  pmrem.dispose();

  const group = new THREE.Group();
  const sky = new THREE.Mesh(dome, skyMat);
  sky.renderOrder = -10;
  sky.frustumCulled = false;
  group.add(sky);

  // The ringed planet and moons, barely visible through the smog.
  const planet = body(300, 0xf0b98a, 0xb86a5c, 34, 0.22);
  planet.position.copy(new THREE.Vector3(-0.55, 0.42, -0.72).normalize().multiplyScalar(1500));
  planet.rotation.set(0.25, 0, 0.35);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(400, 620, 96),
    new THREE.MeshBasicMaterial({
      color: 0xf3e6d8,
      transparent: true,
      opacity: 0.06,
      side: THREE.DoubleSide,
      depthWrite: false,
      fog: false,
    }),
  );
  ring.rotation.x = Math.PI / 2 - 0.2;
  planet.add(ring);
  group.add(planet);

  const moonA = body(60, 0xdfe8f2, 0xdfe8f2, 0, 0.35);
  moonA.position.copy(new THREE.Vector3(0.8, 0.5, -0.3).normalize().multiplyScalar(1500));
  group.add(moonA);
  const moonB = body(32, 0xd9c8f0, 0xd9c8f0, 0, 0.35);
  moonB.position.copy(new THREE.Vector3(0.2, 0.75, 0.6).normalize().multiplyScalar(1500));
  group.add(moonB);

  scene.add(group);
  return {
    /** Keep the sky centred on the camera so it never gets closer. */
    update(pos: THREE.Vector3) {
      group.position.copy(pos);
    },
  };
}
