/* Voice playback: pre-rendered neural voice per lecturer (Web Audio) with a loudness envelope that drives lip-sync;
   per-line clip manifest from the media service when available; browser speech as the last fallback. */
import type { Rig } from './avatar'

type Clip = { o: number; d: number; e: string; env?: Uint8Array }
type Bank = { fps: number; clips: Record<string, Clip> }

export type SayOpts = { avatarId: string; rig?: Rig | null; muted?: boolean; rate?: number; volume?: number; voiceHint?: [string, string]; pitch?: number;
  onVideo?: (url: string | null) => void
  /** Plays a rendered full-body clip (with its own audio track); resolves true when it ends. */
  playVideo?: (url: string, rate: number, muted: boolean, volume: number) => Promise<boolean> }

class VoiceEngine {
  ctx: AudioContext | null = null
  gain: GainNode | null = null
  banks: Record<string, Bank> = {}
  bufs: Record<string, AudioBuffer> = {}
  prom: Partial<Record<string, Promise<boolean>>> = {}
  manifest: Record<string, Record<string, { audio_url?: string; video_url?: string; envelope?: string; duration?: number }>> = {}
  lineBufs: Record<string, AudioBuffer> = {}
  cur: AudioBufferSourceNode | null = null
  token = 0
  speaking = false
  voices: SpeechSynthesisVoice[] = []

  constructor() {
    if ('speechSynthesis' in window) {
      const load = () => { this.voices = speechSynthesis.getVoices().filter(v => /^en/i.test(v.lang)) }
      load(); speechSynthesis.onvoiceschanged = load
    }
  }
  ensure() {
    if (!this.ctx) { const AC = (window as any).AudioContext || (window as any).webkitAudioContext; if (!AC) return null; this.ctx = new AC(); this.gain = this.ctx!.createGain(); this.gain.connect(this.ctx!.destination) }
    return this.ctx
  }
  unlock() { const c = this.ensure(); if (c && c.state === 'suspended') c.resume().catch(() => { }) }
  load(id: string) {
    const existing = this.prom[id]; if (existing) return existing
    const c = this.ensure(); if (!c) return Promise.resolve(false)
    this.prom[id] = (async () => {
      try {
        const [j, ab] = await Promise.all([
          fetch(`/assets/voice/${id}.json`).then(r => { if (!r.ok) throw 0; return r.json() }),
          fetch(`/assets/voice/${id}.mp3`).then(r => { if (!r.ok) throw 0; return r.arrayBuffer() })])
        this.bufs[id] = await new Promise<AudioBuffer>((res, rej) => c.decodeAudioData(ab, res, rej)); this.banks[id] = j
        return true
      } catch { delete this.prom[id]; return false }
    })()
    return this.prom[id]!
  }
  setManifest(avatarId: string, m: Record<string, any>) { this.manifest[avatarId] = { ...(this.manifest[avatarId] || {}), ...m } }
  ready(id: string) { return !!this.bufs[id] }
  stop() { try { this.cur?.stop() } catch { } this.cur = null }
  cancel() { this.token++; this.speaking = false; this.stop(); if ('speechSynthesis' in window) try { speechSynthesis.cancel() } catch { } }

  private bankClip(id: string, text: string) {
    const d = this.banks[id]; if (!d || !this.bufs[id]) return null
    const c = d.clips[text]; if (!c) return null
    if (!c.env) { const bin = atob(c.e); c.env = Uint8Array.from(bin, ch => ch.charCodeAt(0)) }
    return { o: c.o, d: c.d, env: c.env, fps: d.fps, buf: this.bufs[id] }
  }
  private async lineClip(id: string, hash: string) {
    const m = this.manifest[id]?.[hash]; if (!m?.audio_url) return null
    const c = this.ensure(); if (!c) return null
    try {
      if (!this.lineBufs[hash]) { const ab = await fetch(m.audio_url).then(r => { if (!r.ok) throw 0; return r.arrayBuffer() }); this.lineBufs[hash] = await new Promise<AudioBuffer>((res, rej) => c.decodeAudioData(ab, res, rej)) }
      const env = m.envelope ? Uint8Array.from(atob(m.envelope), ch => ch.charCodeAt(0)) : new Uint8Array(0)
      return { o: 0, d: this.lineBufs[hash].duration, env, fps: 50, buf: this.lineBufs[hash], video: m.video_url || null }
    } catch { return null }
  }
  pickVoice(hint?: [string, string]) {
    if (!this.voices.length) return null
    const [g, lang] = hint || ['female', 'en-GB']
    const male = /male|daniel|george|ryan|guy|david|mark|james|arthur|rishi|oliver|thomas|aaron|fred|alex|andrew|brian|christopher|eric/i
    const female = /female|serena|sonia|libby|hazel|susan|zira|aria|jenny|samantha|karen|moira|tessa|veena|heera|neerja|victoria|kate|martha|fiona|ava|emma|michelle|natasha/i
    const rx = g === 'male' ? male : female, nrx = g === 'male' ? female : male
    const nat = (v: SpeechSynthesisVoice) => /natural|neural|online|google/i.test(v.name)
    const pool = this.voices.filter(v => rx.test(v.name) && !nrx.test(v.name))
    return pool.find(v => nat(v) && v.lang.replace('_', '-') === lang) || pool.find(nat) || pool.find(v => v.lang.replace('_', '-') === lang) || pool[0] || this.voices.find(nat) || this.voices[0]
  }

  /** Speak one line. Resolves true when finished, false if cancelled. */
  async say(text: string, hash: string, o: SayOpts): Promise<boolean> {
    const my = ++this.token; this.speaking = true; this.stop()
    const rate = Math.min(1.4, Math.max(0.7, o.rate || 1)); const vol = o.volume ?? 0.9
    const clip: any = (await this.lineClip(o.avatarId, hash)) || this.bankClip(o.avatarId, text)
    if (my !== this.token) return false
    if (clip?.video && o.playVideo) {
      o.rig?.setMouth(0)
      const ok = await o.playVideo(clip.video, rate, !!o.muted, vol)
      if (my === this.token) this.speaking = false
      return ok && my === this.token
    }
    o.onVideo?.(null)
    return new Promise<boolean>(res => {
      let done = false; let pump: any, wd: any, check: any
      const finish = (ok: boolean) => {
        if (done) return; done = true; clearInterval(pump); clearTimeout(wd); clearInterval(check); o.rig?.setMouth(0)
        if (my === this.token) { this.speaking = false; this.cur = null }
        res(ok && my === this.token)
      }
      check = setInterval(() => { if (my !== this.token) finish(false) }, 80)
      if (clip) {
        const start = performance.now(); const dur = clip.d / rate * 1000
        pump = setInterval(() => { const t = (performance.now() - start) / 1000 * rate; const i = Math.floor(t * clip.fps); o.rig?.setMouth(i < clip.env.length ? clip.env[i] / 255 * 0.8 : 0) }, 20)
        if (!o.muted && vol > 0 && this.ctx) {
          const src = this.ctx.createBufferSource(); src.buffer = clip.buf; src.playbackRate.value = rate; this.gain!.gain.value = vol; src.connect(this.gain!)
          src.onended = () => finish(true); this.cur = src; src.start(0, clip.o, clip.d); wd = setTimeout(() => finish(true), dur + 1500)
        } else wd = setTimeout(() => finish(true), dur)
        return
      }
      const words = text.split(/\s+/).length; const est = (words / (2.55 * rate)) * 1000 + 250; const start = performance.now()
      pump = setInterval(() => { const t = (performance.now() - start) / 1000; o.rig?.setMouth(Math.max(0, 0.3 + 0.4 * Math.abs(Math.sin(t * 11.5)) * (0.6 + 0.4 * Math.sin(t * 3.1)) - (Math.random() < 0.12 ? 0.4 : 0))) }, 55)
      if ('speechSynthesis' in window && !o.muted && vol > 0) {
        try {
          const u = new SpeechSynthesisUtterance(text); const v = this.pickVoice(o.voiceHint); if (v) u.voice = v
          u.rate = rate; u.pitch = o.pitch || 1; u.volume = vol
          u.onend = () => finish(true); u.onerror = () => finish(my === this.token); speechSynthesis.speak(u); wd = setTimeout(() => finish(true), est * 2.2 + 3000)
        } catch { wd = setTimeout(() => finish(true), est) }
      } else wd = setTimeout(() => finish(true), est)
    })
  }
}

export const Voice = new VoiceEngine()
