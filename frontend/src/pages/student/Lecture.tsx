/* Narrated lecture player: the course's virtual lecturer presents chapter slides, voiced line by line with the rendered
   neural voice + lip-sync (or the full-body video clip once rendered). Position is in seconds of narration. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../components/Icon'
import { SlideBody, SlideSpec, isSlideSpec } from '../../components/SlideView'
import { AvatarInfo, mountAvatar, Rig } from '../../classroom/avatar'
import { Voice } from '../../classroom/voice'
import { mmss } from './shared'

export type LectureLine = { hash: string; text: string; t: number; dur: number; audio_url?: string | null; envelope?: string | null; video_url?: string | null }
export type LectureData = {
  avatar: (AvatarInfo & { voice_hint?: [string, string] }) | null
  chapters: { i: number; title: string; slide?: SlideSpec | null; t: number; lines: LectureLine[] }[]
  duration: number; lines: number; ready: number
  production?: Production | null
}
export type Production = {
  video_url: string; poster_url?: string; captions_url?: string; duration: number; partial?: boolean; built_at?: string
  chapters: { title: string; t: number }[]; covers_chapters: number; studio_only?: boolean
  cues?: { t: number; end: number; text: string }[]
}

type Flat = LectureLine & { ch: number; li: number }

export function Lecture({ data, title, startAt, captionsDefault, reducedMotion, onPosition, onEnded }: {
  data: LectureData; title: string; startAt: number; captionsDefault: boolean; reducedMotion?: boolean
  onPosition: (pos: number, playing: boolean) => void; onEnded: () => void
}) {
  const flat = useMemo<Flat[]>(() => data.chapters.flatMap((c, ci) => c.lines.map((l, li) => ({ ...l, ch: ci, li }))), [data])
  const total = data.duration
  const idxAt = useCallback((t: number) => { let k = 0; for (let i = 0; i < flat.length; i++) if (flat[i].t <= t + 0.01) k = i; return k }, [flat])
  const [cur, setCur] = useState(() => idxAt(Math.min(startAt, total - 1)))
  const [t, setT] = useState(() => flat[idxAt(Math.min(startAt, total - 1))]?.t || 0)
  const [playing, setPlaying] = useState(false)
  const [cc, setCc] = useState(captionsDefault)
  const [muted, setMuted] = useState(false)
  const [rate, setRate] = useState(1)
  const [video, setVideo] = useState<string | null>(null)
  const [showToc, setShowToc] = useState(false)
  const stageRef = useRef<HTMLDivElement>(null); const rigRef = useRef<Rig | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null); const videoDone = useRef<((ok: boolean) => void) | null>(null)
  const run = useRef(0); const lineStart = useRef(0); const curRef = useRef(cur); curRef.current = cur
  const tRef = useRef(t); tRef.current = t
  const av = data.avatar

  // avatar rig + rendered-clip manifest
  useEffect(() => {
    if (!av || !stageRef.current) return
    stageRef.current.innerHTML = ''
    rigRef.current = mountAvatar(stageRef.current, av, !!reducedMotion)
    const m: Record<string, any> = {}
    for (const l of flat) if (l.audio_url) m[l.hash] = { audio_url: l.audio_url, envelope: l.envelope, video_url: l.video_url, duration: l.dur }
    Voice.setManifest(av.id, m)
    return () => { rigRef.current?.destroy(); rigRef.current = null }
  }, [av, flat, reducedMotion])
  useEffect(() => () => { run.current++; Voice.cancel() }, [])

  const playVideo = useCallback((url: string, r: number, mute: boolean, vol: number) => new Promise<boolean>(resolve => {
    videoDone.current?.(false); videoDone.current = resolve; setVideo(url)
    requestAnimationFrame(() => {
      const v = videoRef.current; if (!v) return resolve(false)
      v.playbackRate = r; v.muted = mute; v.volume = vol
      v.play().catch(() => { v.muted = true; v.play().catch(() => resolve(false)) })
    })
  }), [])
  const endVideo = (ok: boolean) => { const d = videoDone.current; videoDone.current = null; setVideo(null); d?.(ok) }

  // clock: interpolate within the current line while it plays
  useEffect(() => {
    if (!playing) return
    let raf = 0
    const tick = () => { const l = flat[curRef.current]; if (l) setT(Math.min(l.t + l.dur, l.t + (performance.now() - lineStart.current) / 1000 * rate)); raf = requestAnimationFrame(tick) }
    raf = requestAnimationFrame(tick); return () => cancelAnimationFrame(raf)
  }, [playing, flat, rate])

  const playFrom = useCallback(async (i: number) => {
    const my = ++run.current
    Voice.unlock(); setPlaying(true)
    for (let k = i; k < flat.length; k++) {
      if (my !== run.current) return
      const l = flat[k]
      setCur(k); setT(l.t); lineStart.current = performance.now()
      const ok = await Voice.say(l.text, l.hash, { avatarId: av?.id || 'none', rig: rigRef.current, muted, rate, volume: 0.95, voiceHint: av?.voice_hint, pitch: (av?.calib as any)?.pitch, playVideo })
      if (!ok || my !== run.current) return
      const gap = flat[k + 1] && flat[k + 1].ch !== l.ch ? 900 : 380
      await new Promise(r => setTimeout(r, gap / rate))
      if (my !== run.current) return
      if (k === flat.length - 1) { setT(total); setPlaying(false); onPosition(Math.round(total), false); onEnded(); return }
    }
  }, [flat, av, muted, rate, playVideo, total, onEnded, onPosition])

  const pause = useCallback(() => { run.current++; Voice.cancel(); if (videoRef.current) videoRef.current.pause(); endVideo(false); setPlaying(false); onPosition(Math.round(tRef.current), false) }, [onPosition])
  const toggle = () => { if (playing) pause(); else playFrom(cur >= flat.length - 1 && t >= total - 0.5 ? 0 : cur) }
  const seekTo = (i: number) => { i = Math.max(0, Math.min(flat.length - 1, i)); const was = playing; run.current++; Voice.cancel(); endVideo(false); setCur(i); setT(flat[i].t); if (was) playFrom(i); else onPosition(Math.round(flat[i].t), false) }
  // replay with new speed / mute from the current line
  const restartIfPlaying = () => { if (playing) { run.current++; Voice.cancel(); endVideo(false); setTimeout(() => playFrom(curRef.current), 0) } }
  useEffect(() => { restartIfPlaying() }, [rate, muted]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const id = setInterval(() => { if (playing) onPosition(Math.round(tRef.current), true) }, 15000); return () => clearInterval(id) }, [playing, onPosition])

  // keyboard: Space play/pause, ←/→ previous/next sentence, C captions
  const box = useRef<HTMLDivElement>(null)
  const onKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input,textarea,select')) return
    if (e.key === ' ' || e.key === 'k') { e.preventDefault(); toggle() }
    else if (e.key === 'ArrowRight') { e.preventDefault(); seekTo(cur + 1) }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); seekTo(cur - 1) }
    else if (e.key === 'c') setCc(x => !x)
  }

  const line = flat[cur]; const ch = data.chapters[line?.ch ?? 0]
  const pct = total ? Math.min(100, (t / total) * 100) : 0
  const pending = data.lines - data.ready
  return <div className="lecture" ref={box} tabIndex={0} onKeyDown={onKey} aria-label={`Lecture: ${title}. Space to play or pause, arrow keys to move between sentences.`}>
    <div className="lec-main">
      <div className="lec-slide slide" aria-live="polite">
        <div className="sh"><Icon n="file" /><span>Chapter {(line?.ch ?? 0) + 1} of {data.chapters.length} · {ch?.title}</span></div>
        <div className="sb">{ch && isSlideSpec(ch.slide) ? <SlideBody s={ch.slide} /> : <h3>{ch?.title}</h3>}</div>
      </div>
      <div className="lec-stage stage">
        <div className="bgx" /><div className="shelf" /><div className="win" />
        <div ref={stageRef} style={{ position: 'absolute', inset: 0 }} />
        {video && <video ref={videoRef} className="media" src={video} playsInline onEnded={() => endVideo(true)} onError={() => endVideo(false)} />}
        {av && <div className="namecard"><b>{av.name}</b><span>Virtual lecturer · AI-generated</span></div>}
      </div>
    </div>
    {cc && line && (playing || t > 0) && <div className="lec-cap" aria-live="polite">{line.text}</div>}
    <div className="lec-ctl">
      <button className="iconbtn" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}><Icon n={playing ? 'pause' : 'playc'} /></button>
      <button className="iconbtn" onClick={() => seekTo(cur - 1)} aria-label="Previous sentence" disabled={cur === 0}><Icon n="back" /></button>
      <button className="iconbtn" onClick={() => seekTo(cur + 1)} aria-label="Next sentence" disabled={cur >= flat.length - 1}><Icon n="chev" /></button>
      <span className="num">{mmss(t)} / {mmss(total)}</span>
      <div className="lec-bar" role="slider" tabIndex={0} aria-label="Seek" aria-valuemin={0} aria-valuemax={Math.round(total)} aria-valuenow={Math.round(t)}
        onClick={e => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); seekTo(idxAt(total * (e.clientX - r.left) / r.width)) }}>
        <i style={{ width: `${pct}%` }} />
        {data.chapters.slice(1).map(c => <b key={c.i} style={{ left: `${(c.t / total) * 100}%` }} title={c.title} />)}
      </div>
      <button className={`iconbtn ${showToc ? 'on' : ''}`} onClick={() => setShowToc(x => !x)} aria-pressed={showToc} aria-label="Chapters"><Icon n="list" /></button>
      <button className={`iconbtn ${cc ? 'on' : ''}`} onClick={() => setCc(x => !x)} aria-pressed={cc} aria-label="Captions"><Icon n="cc" /></button>
      <button className="iconbtn" onClick={() => setMuted(x => !x)} aria-pressed={muted} aria-label={muted ? 'Unmute' : 'Mute'}><Icon n={muted ? 'mute' : 'vol'} /></button>
      <select className="lec-rate" aria-label="Playback speed" value={rate} onChange={e => setRate(+e.target.value)}>{[0.8, 0.9, 1, 1.1, 1.25].map(r => <option key={r} value={r}>{r}×</option>)}</select>
    </div>
    {showToc && <ol className="lec-toc">{data.chapters.map(c => <li key={c.i} className={c.i === line?.ch ? 'on' : ''}>
      <button className="link-btn" onClick={() => seekTo(flat.findIndex(f => f.ch === c.i))}>{c.title}</button><span className="xs muted num">{mmss(c.t)}</span></li>)}</ol>}
    {pending > 0 && <p className="xs muted" style={{ marginTop: 6 }}>Lecturer voice: {data.ready} of {data.lines} lines rendered. The remaining lines use your browser’s voice until rendering finishes.</p>}
  </div>
}
