/* Data-driven lesson slides (docs/curriculum-schema.md → "Slides"). Used by the virtual classroom and the narrated lecture player. */
import { Icon } from './Icon'

export type SlideSpec = {
  kind: 'bullets' | 'steps' | 'compare' | 'cards' | 'stat' | 'formula' | 'code'
  heading: string
  points?: string[]
  steps?: { title: string; sub?: string }[]
  columns?: { title: string; points: string[] }[]
  cards?: { label: string; text: string }[]
  stats?: { value: string; label: string }[]
  formula?: string
  code?: string
  lang?: string
  note?: { tone?: 'info' | 'warn'; text: string }
}

export const isSlideSpec = (s: unknown): s is SlideSpec => !!s && typeof s === 'object' && typeof (s as any).kind === 'string'

function Points({ p }: { p?: string[] }) {
  return p?.length ? <ul>{p.map(x => <li key={x}>{x}</li>)}</ul> : null
}

export function SlideBody({ s }: { s: SlideSpec }) {
  return <div className={`sv sv-${s.kind}`}>
    <h3>{s.heading}</h3>
    {s.kind === 'bullets' && <Points p={s.points} />}
    {s.kind === 'steps' && <ol className="sv-steps">{(s.steps || []).map((x, i) => <li key={i}><span className="n">{i + 1}</span><b>{x.title}</b>{x.sub && <span>{x.sub}</span>}</li>)}</ol>}
    {s.kind === 'compare' && <div className="sv-cols" style={{ gridTemplateColumns: `repeat(${Math.min(3, s.columns?.length || 1)}, minmax(0,1fr))` }}>
      {(s.columns || []).map(c => <div key={c.title} className="sv-col"><div className="eyebrow">{c.title}</div><Points p={c.points} /></div>)}</div>}
    {s.kind === 'cards' && <div className="sv-cards">{(s.cards || []).map(c => <div key={c.label} className="sv-card"><div className="eyebrow">{c.label}</div><div className="small">{c.text}</div></div>)}</div>}
    {s.kind === 'stat' && <div className="sv-stats">{(s.stats || []).map(x => <div key={x.label} className="sv-stat"><b>{x.value}</b><span>{x.label}</span></div>)}</div>}
    {s.kind === 'formula' && <><div className="sv-formula">{s.formula}</div><Points p={s.points} /></>}
    {s.kind === 'code' && <><pre className="sv-code" aria-label={`${s.lang || 'code'} example`}><code>{s.code}</code></pre><Points p={s.points} /></>}
    {s.note?.text && <div className={`note ${s.note.tone === 'warn' ? 'warn' : ''}`}><Icon n={s.note.tone === 'warn' ? 'alert' : 'info'} /><div>{s.note.text}</div></div>}
  </div>
}
