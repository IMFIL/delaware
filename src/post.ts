import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

/**
 * Lens and film look applied to the finished frame: slight colour fringing toward the
 * edges, a vignette, cool shadows against warm highlights, and fine grain.
 */
export function createFilmPass() {
  const pass = new ShaderPass({
    name: 'Film',
    uniforms: {
      tDiffuse: { value: null },
      time: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D tDiffuse;
      uniform float time;
      varying vec2 vUv;

      float hash(vec2 p) {
        p = fract(p * vec2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
      }

      void main() {
        vec2 c = vUv - 0.5;
        float r2 = dot(c, c);
        vec2 fringe = c * r2 * 0.014;
        vec3 col = vec3(
          texture2D(tDiffuse, vUv + fringe).r,
          texture2D(tDiffuse, vUv).g,
          texture2D(tDiffuse, vUv - fringe).b
        );
        float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
        col = mix(col * vec3(0.9, 1.0, 1.1), col * vec3(1.07, 1.0, 0.92), smoothstep(0.03, 0.55, lum));
        col *= 1.0 - r2 * 0.85;
        float grain = hash(vUv * vec2(1731.0, 977.0) + fract(time) * 61.0) - 0.5;
        col += grain * 0.05 * (0.02 + sqrt(max(lum, 0.0)));
        gl_FragColor = vec4(max(col, 0.0), 1.0);
      }`,
  });
  return {
    pass,
    update(dt: number) {
      pass.uniforms.time.value += dt;
    },
  };
}
