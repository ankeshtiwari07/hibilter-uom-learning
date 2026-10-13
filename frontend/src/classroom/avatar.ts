/* Photo-portrait avatar rig: the exact PNG master with gentle idle motion, an optional listening pose, and a
   WebGL lip/jaw warp driven by voice loudness (Tier C). Full-body video clips (Tier A) are layered on top by Stage. */
import { LIP_FS } from './lipShader'

export type Calib = { x: number; y: number; mw: number; chin: number; jaw: number; fade: number; amp: number; smile?: number }
export type AvatarInfo = { id: string; name: string; portrait: string; listen_portrait?: string | null; calib: { lip?: Calib; pos?: string } }
export type Rig = {
  setMouth(v: number): void; setMood(m: string): void; nodOnce(): void; setState(s: string): void; destroy(): void; el: HTMLElement
}

const RIGS = new Set<any>()
let RAF = 0
function loop(t: number) {
  RIGS.forEach(r => r.tick(t / 1000))
  RAF = RIGS.size ? requestAnimationFrame(loop) : 0
}

function makeLipCanvas(img: HTMLImageElement, cal: Calib) {
  const c = document.createElement('canvas'); c.className = 'ph-main ph-gl'
  const gl = c.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: true }) as WebGLRenderingContext | null
  if (!gl) return null
  const sh = (t: number, src: string) => { const x = gl.createShader(t)!; gl.shaderSource(x, src); gl.compileShader(x); return gl.getShaderParameter(x, gl.COMPILE_STATUS) ? x : null }
  const vs = sh(gl.VERTEX_SHADER, 'attribute vec2 P;void main(){gl_Position=vec4(P,0.,1.);}'), fs = sh(gl.FRAGMENT_SHADER, LIP_FS)
  if (!vs || !fs) return null
  const pr = gl.createProgram()!; gl.attachShader(pr, vs); gl.attachShader(pr, fs); gl.linkProgram(pr)
  if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) return null
  gl.useProgram(pr)
  const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
  const loc = gl.getAttribLocation(pr, 'P'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
  const U = (n: string) => gl.getUniformLocation(pr, n)
  let ready = false, last = -1
  const api = { canvas: c, draw(a: number) { if (!ready || Math.abs(a - last) < 0.04) return; last = a; gl.uniform1f(U('A'), a); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4) } }
  const init = () => {
    c.width = img.naturalWidth; c.height = img.naturalHeight; gl.viewport(0, 0, c.width, c.height)
    const tx = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tx); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img)
    ;[gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T].forEach(w => gl.texParameteri(gl.TEXTURE_2D, w, gl.CLAMP_TO_EDGE))
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.uniform2f(U('R'), c.width, c.height); gl.uniform2f(U('M'), cal.x, cal.y); gl.uniform1f(U('MW'), cal.mw); gl.uniform1f(U('CHIN'), cal.chin)
    gl.uniform1f(U('JAW'), cal.jaw); gl.uniform1f(U('FADE'), cal.fade); gl.uniform1f(U('SM'), cal.smile || 5)
    ready = true; last = -1; api.draw(0); c.classList.add('on')
  }
  if (img.complete && img.naturalWidth) init(); else img.addEventListener('load', init, { once: true })
  return api
}

export function mountAvatar(container: HTMLElement, a: AvatarInfo, reduceMotion = false): Rig {
  const div = document.createElement('div'); div.className = 'avatar-photo' + (a.listen_portrait ? ' has-listen' : '')
  const pos = a.calib?.pos || '50% 30%'
  const main = document.createElement('img'); main.className = 'ph-main'; main.src = a.portrait; main.alt = `${a.name}, digital lecturer`; main.style.objectPosition = pos
  div.appendChild(main)
  if (a.listen_portrait) { const l = document.createElement('img'); l.className = 'ph-listen'; l.src = a.listen_portrait; l.alt = ''; l.style.objectPosition = pos; div.appendChild(l) }
  container.appendChild(div)
  let lipc: ReturnType<typeof makeLipCanvas> = null
  if (a.calib?.lip) { try { lipc = makeLipCanvas(main, a.calib.lip) } catch { lipc = null } if (lipc) { lipc.canvas.style.objectPosition = pos; main.after(lipc.canvas) } }
  const reduce = reduceMotion || matchMedia('(prefers-reduced-motion: reduce)').matches
  const rig: any = {
    el: div, mouth: 0, target: 0, state: 'idle', mood: 'neutral', nod: 0, phase: Math.random() * 10,
    setMouth(v: number) { this.target = v }, setMood(m: string) { this.mood = m }, nodOnce() { this.nod = 1 },
    setState(st: string) { this.state = st; div.classList.toggle('listening', st === 'listening' || st === 'thinking') },
    tick(t: number) {
      this.mouth += (this.target - this.mouth) * 0.45; const sp = this.mouth > 0.08
      div.classList.toggle('speaking', sp)
      if (lipc) lipc.draw(Math.pow(Math.max(0, this.mouth), 0.8) * (a.calib.lip!.amp || 15))
      if (reduce) { div.style.setProperty('--tf', 'scale(1.02)'); return }
      const tt = t + this.phase; let ty = Math.cos(tt * 0.17) * 0.35
      if (this.nod > 0) { ty += Math.sin((1 - this.nod) * Math.PI * 2) * 0.6; this.nod = Math.max(0, this.nod - 0.025) }
      const sc = 1.04 + Math.sin(tt * 0.3) * 0.008 + (sp ? 0.004 : 0)
      div.style.setProperty('--tf', `translate(${(Math.sin(tt * 0.21) * 0.5).toFixed(3)}%, ${ty.toFixed(3)}%) scale(${sc.toFixed(4)})`)
    },
    destroy() { RIGS.delete(this); div.remove() },
  }
  RIGS.add(rig); if (!RAF) RAF = requestAnimationFrame(loop)
  return rig
}
