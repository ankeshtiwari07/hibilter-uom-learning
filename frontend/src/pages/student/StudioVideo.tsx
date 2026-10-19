/* Produced lecture video (app.studio): the virtual lecturer filmed beside the slides, with chapters and captions. */
import { useRef, useState } from 'react'
import { Icon } from '../../components/Icon'
import { Production } from './Lecture'
import { mmss } from './shared'

export function StudioVideo({ p, title, captionsDefault, onEnded, onContinue, onPosition }: {
  p: Production; title: string; captionsDefault: boolean; onEnded: () => void; onContinue?: () => void
  onPosition?: (pos: number, live: boolean) => void  // live: while playing; otherwise paused (save it)
}) {
  const v = useRef<HTMLVideoElement>(null)
  const [t, setT] = useState(0)
  const [ended, setEnded] = useState(false)
  const ch = [...p.chapters].reverse().find(c => c.t <= t + 0.2)
  const seek = (s: number) => { const el = v.current; if (!el) return; el.currentTime = s; el.play().catch(() => { }) }
  return <div className="studio">
    <div className="studio-frame">
      <video ref={v} src={p.video_url} poster={p.poster_url} controls playsInline preload="metadata" aria-label={`Lecture video: ${title}`}
        onTimeUpdate={e => { const s = (e.target as HTMLVideoElement).currentTime; setT(s); onPosition?.(s, true) }} onPlay={() => setEnded(false)}
        onPause={e => onPosition?.((e.target as HTMLVideoElement).currentTime, false)}
        onEnded={() => { setEnded(true); if (!p.partial) onEnded() }}>
        {p.captions_url && <track kind="captions" src={p.captions_url} srcLang="en" label="English" default={captionsDefault} />}
      </video>
      {ended && p.partial && onContinue && <div className="studio-end">
        <b>End of the studio preview</b><span className="small">The rest of this lecture continues with narrated slides.</span>
        <button className="btn teal" onClick={onContinue}><Icon n="playc" />Continue the lecture</button></div>}
    </div>
    {p.chapters.length > 0 && <div className="studio-ch" role="list" aria-label="Chapters">
      {p.chapters.map((c, i) => <button key={i} role="listitem" className={`studio-chip ${ch === c ? 'on' : ''}`} onClick={() => seek(c.t)}>
        <span className="num xs">{mmss(c.t)}</span>{c.title}</button>)}
    </div>}
    <p className="xs muted" style={{ marginTop: 6 }}><Icon n="info" /> AI-generated video of a virtual lecturer{p.partial ? ' · studio preview of the opening chapter' : ''}.</p>
  </div>
}
