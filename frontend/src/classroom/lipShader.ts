export const LIP_FS = `precision mediump float;
uniform sampler2D T; uniform vec2 R; uniform vec2 M; uniform float MW, CHIN, JAW, A, FADE, SM;
void main(){
  vec2 p = vec2(gl_FragCoord.x, R.y - gl_FragCoord.y);
  float dx = abs(p.x - M.x); vec2 src = p;
  float r = dx / MW; float ly = M.y - SM * min(r * r, 1.2);
  if (A > 0.05 && p.y > ly - 16.0 && p.y < CHIN + 30.0 && dx < JAW) {
    float wJaw = 1.0 - smoothstep(JAW * 0.45, JAW, dx);
    float lip = clamp(1.0 - pow(dx / (MW * 0.86), 2.0), 0.0, 1.0);
    if (p.y < ly) {
      float up = A * 0.25 * pow(lip, 0.6) * (1.0 - smoothstep(0.0, 16.0, ly - p.y));
      src.y = p.y + up;
      gl_FragColor = texture2D(T, src / R); return;
    }
    float k = smoothstep(0.0, 24.0, p.y - ly);
    float prof = mix(pow(lip, 0.55), 1.0, k) * wJaw;
    float t = clamp((p.y - M.y) / (CHIN + 30.0 - M.y), 0.0, 1.0);
    float D = A * prof * (1.0 - smoothstep(FADE, 1.0, t));
    src.y = p.y - D;
    float upD = A * 0.25 * pow(lip, 0.6);
    if (src.y < ly && lip > 0.0) {
      float g = (p.y - ly) / max(D, 0.001);
      vec3 inner = mix(vec3(0.40, 0.16, 0.15), vec3(0.17, 0.06, 0.07), smoothstep(0.0, 0.85, g));
      float teeth = (1.0 - smoothstep(0.16, 0.36, g)) * smoothstep(8.0, 12.0, A * lip);
      inner = mix(inner, vec3(0.80, 0.76, 0.72), teeth * 0.5);
      vec3 base = texture2D(T, vec2(p.x, ly + 2.0) / R).rgb;
      float e = smoothstep(0.0, 2.0, ly - src.y) * smoothstep(0.0, 0.25, lip) * smoothstep(0.0, 1.5, p.y - ly + 1.0);
      gl_FragColor = vec4(mix(base, inner, e), 1.0); return;
    }
  }
  gl_FragColor = texture2D(T, src / R);
}`;
