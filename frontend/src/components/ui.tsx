import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import { initials } from '../lib/format'

export function Badge({ kind = '', children, dot }: { kind?: string; children: ReactNode; dot?: boolean }) {
  return <span className={`b ${kind}`}>{dot && <i className="d" />}{children}</span>
}
export function AiTag({ label = 'AI' }: { label?: string }) { return <span className="ai-tag"><Icon n="ai" />{label}</span> }

export function Card({ title, actions, children, className = '', flat }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; flat?: boolean }) {
  return <section className={`card ${flat ? 'flat' : ''} ${className}`}>
    {(title || actions) && <div className="hd"><h3>{title}</h3>{actions}</div>}
    {children}
  </section>
}

export function Kpi({ label, value, delta, up, tip }: { label: string; value: ReactNode; delta?: ReactNode; up?: boolean; tip?: string }) {
  return <div className="kpi"><div className="l">{label}{tip && <i className="info" tabIndex={0} data-tip={tip}>i</i>}</div>
    <div className="v">{value}</div>{delta != null && <div className="d"><span className={up ? 'up' : up === false ? 'dn' : ''}>{delta}</span></div>}</div>
}

export function Bar({ v, kind = '' }: { v: number; kind?: string }) {
  return <div className={`bar ${kind}`} role="progressbar" aria-valuenow={Math.round(v)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${Math.max(0, Math.min(100, v))}%` }} /></div>
}

export function Ring({ p, label }: { p: number; label?: string }) {
  return <div className="ring" style={{ ['--p' as any]: p }} data-l={label ?? `${Math.round(p)}%`} />
}

export function Avatar({ name, kind = '', size }: { name: string; kind?: string; size?: number }) {
  return <span className={`av ${kind}`} style={size ? { width: size, height: size, fontSize: size * 0.36 } : undefined}>{initials(name)}</span>
}

export function Empty({ icon = 'info', title, children }: { icon?: string; title: string; children?: ReactNode }) {
  return <div className="empty"><Icon n={icon} /><b>{title}</b>{children && <div className="small">{children}</div>}</div>
}

export function Note({ kind = '', icon = 'info', children }: { kind?: string; icon?: string; children: ReactNode }) {
  return <div className={`note ${kind}`}><Icon n={icon} /><div>{children}</div></div>
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <div className="empty" aria-busy="true"><span className="typing"><i /><i /><i /></span><span className="small">{label}</span></div>
}

export function ErrorBox({ error, retry }: { error: any; retry?: () => void }) {
  return <div className="note bad"><Icon n="alert" /><div><b>Couldn’t load this.</b> {error?.message || String(error)} {retry && <button className="btn sm" onClick={retry}>Try again</button>}</div></div>
}

export function PageHead({ title, sub, actions, no }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; no?: number }) {
  return <div className="ph"><div className="t"><h1>{title}{no != null && <span className="screen-no">S{String(no).padStart(2, '0')}</span>}</h1>{sub && <p className="sub">{sub}</p>}</div>{actions && <div className="acts">{actions}</div>}</div>
}

export function Tabs({ tabs, value, onChange }: { tabs: [string, string][]; value: string; onChange: (v: string) => void }) {
  return <div className="tabs" role="tablist">{tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={k === value} className={k === value ? 'on' : ''} onClick={() => onChange(k)}>{l}</button>)}</div>
}

export function Seg({ options, value, onChange }: { options: [string, string][]; value: string; onChange: (v: string) => void }) {
  return <div className="seg">{options.map(([k, l]) => <button key={k} className={k === value ? 'on' : ''} onClick={() => onChange(k)} aria-pressed={k === value}>{l}</button>)}</div>
}

export function Switch({ checked, onChange, label, id }: { checked: boolean; onChange: (v: boolean) => void; label?: string; id: string }) {
  return <label className="chk" htmlFor={id}><span className="switch"><input id={id} type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} /><span /></span>{label}</label>
}

export function Field({ label, hint, error, children, htmlFor }: { label: string; hint?: string; error?: string | null; children: ReactNode; htmlFor?: string }) {
  return <div className="field"><label htmlFor={htmlFor}>{label}</label>{children}{hint && !error && <span className="hint">{hint}</span>}{error && <span className="err"><Icon n="alert" />{error}</span>}</div>
}

/* ---------- Modal ---------- */
export function Modal({ title, onClose, children, footer, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', k); ref.current?.querySelector<HTMLElement>('button,input,select,textarea')?.focus()
    return () => document.removeEventListener('keydown', k)
  }, [onClose])
  return <div className="scrim" onMouseDown={e => e.target === e.currentTarget && onClose()}>
    <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" ref={ref}>
      <div className="mh"><h2>{title}</h2><button className="iconbtn" onClick={onClose} aria-label="Close"><Icon n="x" /></button></div>
      <div className="mb">{children}</div>
      {footer && <div className="mf">{footer}</div>}
    </div>
  </div>
}

/* ---------- Toasts ---------- */
type T = { id: number; msg: string; err?: boolean }
const ToastCtx = createContext<(msg: string, err?: boolean) => void>(() => { })
export const useToast = () => useContext(ToastCtx)
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, set] = useState<T[]>([])
  const push = useCallback((msg: string, err = false) => {
    const id = Date.now() + Math.random(); set(x => [...x, { id, msg, err }]); setTimeout(() => set(x => x.filter(t => t.id !== id)), 4200)
  }, [])
  return <ToastCtx.Provider value={push}>{children}
    <div className="toasts" aria-live="polite">{items.map(t => <div key={t.id} className={`toast ${t.err ? 'err' : ''}`}><Icon n={t.err ? 'alert' : 'checkc'} /><div>{t.msg}</div></div>)}</div>
  </ToastCtx.Provider>
}

/* ---------- Simple SVG charts ---------- */
export function LineChart({ series, labels, height = 180, max }: { series: { name: string; color: string; data: number[] }[]; labels: string[]; height?: number; max?: number }) {
  const W = 560, H = height, pl = 34, pr = 10, pt = 10, pb = 24
  const top = max ?? Math.max(10, ...series.flatMap(s => s.data)) * 1.1
  const x = (i: number) => pl + (labels.length < 2 ? 0 : (i * (W - pl - pr)) / (labels.length - 1))
  const y = (v: number) => pt + (H - pt - pb) * (1 - v / top)
  const ticks = [0, .25, .5, .75, 1].map(f => Math.round(top * f))
  return <div><svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={series.map(s => s.name).join(', ')}>
    {ticks.map(t => <g key={t}><line className="grid" x1={pl} x2={W - pr} y1={y(t)} y2={y(t)} /><text x={pl - 6} y={y(t) + 4} textAnchor="end">{t}</text></g>)}
    {labels.map((l, i) => <text key={l + i} x={x(i)} y={H - 6} textAnchor="middle">{l}</text>)}
    {series.map(s => <g key={s.name}>
      <path d={s.data.map((v, i) => `${i ? 'L' : 'M'}${x(i)},${y(v)}`).join('')} fill="none" stroke={s.color} strokeWidth={2.2} />
      {s.data.map((v, i) => <circle key={i} cx={x(i)} cy={y(v)} r={i === s.data.length - 1 ? 4 : 2.5} fill={s.color} />)}
    </g>)}
  </svg><div className="legend">{series.map(s => <span key={s.name}><i style={{ background: s.color }} />{s.name}</span>)}</div></div>
}

export function HBars({ rows, suffix = '', max }: { rows: { label: string; value: number; kind?: string }[]; suffix?: string; max?: number }) {
  const m = max ?? Math.max(1, ...rows.map(r => r.value))
  return <div>{rows.map(r => <div className="hbar" key={r.label}><span className="lbl" title={r.label}>{r.label}</span>
    <span className="track"><i style={{ width: `${(r.value / m) * 100}%`, background: r.kind ? `var(--${r.kind})` : undefined }} /></span>
    <span className="val">{Math.round(r.value * 10) / 10}{suffix}</span></div>)}</div>
}

export function VBars({ data, height = 160, color = 'var(--navy)' }: { data: { label: string; value: number }[]; height?: number; color?: string }) {
  const W = 560, H = height, pb = 22, pt = 8, max = Math.max(1, ...data.map(d => d.value))
  const bw = (W - 20) / data.length
  return <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img">
    {data.map((d, i) => { const h = (H - pb - pt) * d.value / max; return <g key={d.label}>
      <rect x={10 + i * bw + bw * .18} y={H - pb - h} width={bw * .64} height={h} rx={3} fill={color} />
      <text x={10 + i * bw + bw / 2} y={H - 6} textAnchor="middle">{d.label}</text>
      <text x={10 + i * bw + bw / 2} y={H - pb - h - 4} textAnchor="middle">{d.value}</text></g> })}
  </svg>
}
