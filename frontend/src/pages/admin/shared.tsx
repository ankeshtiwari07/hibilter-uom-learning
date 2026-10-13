/* Shared helpers for the administrator portal pages. */
import { useQuery } from '@tanstack/react-query'
import { ReactNode, useEffect, useState } from 'react'
import { Icon } from '../../components/Icon'
import { get } from '../../lib/api'

export type Faculty = { id: string; name: string; short: string }
export type Programme = { id: string; faculty_id: string; name: string; level: string; years: number }
export type Term = { id: string; name: string; start: string; end: string; current: boolean }
export type CourseRef = { id: string; code: string; title: string; faculty_id: string; programme_id: string | null; term: string; status: string }
export type Staff = { id: string; name: string; role: string; faculty_id: string | null; status: string }
export type Meta = { faculties: Faculty[]; programmes: Programme[]; terms: Term[]; course_terms: string[]; courses: CourseRef[]; staff: Staff[]; definitions: Record<string, string> }

export function useMeta() {
  return useQuery({ queryKey: ['admin-meta'], queryFn: () => get<Meta>('/api/admin/meta'), staleTime: 60_000 })
}

/** Build a query string, dropping empty and 'all' values. */
export function qs(o: Record<string, string | number | undefined | null>) {
  const p = new URLSearchParams()
  Object.entries(o).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '' && v !== 'all') p.set(k, String(v)) })
  const s = p.toString(); return s ? `?${s}` : ''
}

export function useDebounced<T>(v: T, ms = 300) {
  const [d, setD] = useState(v)
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t) }, [v, ms])
  return d
}

export const n1 = (v: number | null | undefined, suffix = '') => (v == null ? '—' : `${Math.round(v * 10) / 10}${suffix}`)
export const n0 = (v: number | null | undefined, suffix = '') => (v == null ? '—' : `${Math.round(v)}${suffix}`)

export function Sel({ id, label, value, onChange, options, hint, disabled }: { id: string; label: string; value: string; onChange: (v: string) => void; options: [string, string][]; hint?: string; disabled?: boolean }) {
  return <div className="field"><label htmlFor={id}>{label}</label>
    <select className="inp" id={id} value={value} disabled={disabled} onChange={e => onChange(e.target.value)}>{options.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
    {hint && <span className="hint">{hint}</span>}</div>
}

export function InlineErr({ msg }: { msg?: string | null }) {
  return msg ? <span className="err" role="alert"><Icon n="alert" />{msg}</span> : null
}

export function DemoTag({ children = 'Synthetic data — not UoM statistics' }: { children?: ReactNode }) { return <span className="demo-tag">{children}</span> }

export function Tip({ text }: { text: string }) {
  return <i className="info" tabIndex={0} data-tip={text} aria-label={text}>i</i>
}

export type Scope = { faculty: string; programme: string; term: string }
export const ALL_SCOPE: Scope = { faculty: 'all', programme: 'all', term: 'all' }

/** Faculty / programme / semester filter bar shared by dashboards (the demo's filterBar). */
export function ScopeBar({ meta, value, onChange, children, prefix }: { meta?: Meta; value: Scope; onChange: (s: Scope) => void; children?: ReactNode; prefix: string }) {
  const progs = (meta?.programmes || []).filter(p => value.faculty === 'all' || p.faculty_id === value.faculty)
  return <div className="card" style={{ padding: '12px 14px' }}><div className="filters">
    <Sel id={`${prefix}-fac`} label="Faculty / centre" value={value.faculty} onChange={v => onChange({ ...value, faculty: v, programme: 'all' })}
      options={[['all', 'All faculties & centres'], ...(meta?.faculties || []).map(f => [f.id, f.short] as [string, string])]} />
    <Sel id={`${prefix}-prog`} label="Programme" value={value.programme} onChange={v => onChange({ ...value, programme: v })}
      options={[['all', 'All programmes'], ...progs.map(p => [p.id, p.name] as [string, string])]} />
    <Sel id={`${prefix}-sem`} label="Semester" value={value.term} onChange={v => onChange({ ...value, term: v })}
      options={[['all', 'All semesters'], ...(meta?.course_terms || []).map(t => [t, t] as [string, string])]} />
    {children}
    <span className="sp" /><DemoTag>Illustrative figures — not UoM statistics</DemoTag>
  </div></div>
}

export function Pager({ page, size, total, onPage, label = 'records' }: { page: number; size: number; total: number; onPage: (p: number) => void; label?: string }) {
  const pages = Math.max(1, Math.ceil(total / size))
  const from = total ? (page - 1) * size + 1 : 0, to = Math.min(total, page * size)
  return <div className="row sb" style={{ marginTop: 10 }}>
    <span className="xs muted">{from}–{to} of {total.toLocaleString()} {label}</span>
    <div className="row" style={{ gap: 6 }}>
      <button className="btn sm" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page"><Icon n="back" />Prev</button>
      <span className="xs muted">Page {page} of {pages}</span>
      <button className="btn sm" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page">Next<Icon n="arrow" /></button>
    </div>
  </div>
}

/** Grouped vertical bars (two or more series) — the demo's barChart. */
export function GroupBars({ labels, series, max = 100, unit = '%', height = 190 }: { labels: string[]; series: { name: string; color: string; data: (number | null)[] }[]; max?: number; unit?: string; height?: number }) {
  const W = 560, H = height, pl = 30, pb = 24, pt = 12
  const gw = (W - pl - 6) / Math.max(1, labels.length), bw = Math.min(26, (gw * .74) / series.length)
  const y = (v: number) => pt + (H - pt - pb) * (1 - v / max)
  return <div><svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={series.map(s => s.name).join(' and ') + ' by ' + labels.join(', ')}>
    {[0, .25, .5, .75, 1].map(f => <g key={f}><line className="grid" x1={pl} x2={W - 6} y1={y(max * f)} y2={y(max * f)} /><text x={pl - 6} y={y(max * f) + 4} textAnchor="end">{Math.round(max * f)}</text></g>)}
    {labels.map((l, i) => { const x0 = pl + i * gw + (gw - bw * series.length) / 2
      return <g key={l + i}>{series.map((s, j) => { const v = s.data[i] ?? 0; return <rect key={s.name} x={x0 + j * bw} y={y(v)} width={bw - 2} height={Math.max(0, H - pb - y(v))} rx={2} fill={s.color}><title>{`${l} · ${s.name}: ${s.data[i] == null ? '—' : Math.round(v * 10) / 10 + unit}`}</title></rect> })}
        <text x={pl + i * gw + gw / 2} y={H - 7} textAnchor="middle">{l}</text></g> })}
  </svg><div className="legend">{series.map(s => <span key={s.name}><i style={{ background: s.color }} />{s.name}</span>)}</div></div>
}

export const FOLLOW_KIND: Record<string, string> = { New: 'warn', Contacted: 'info', 'Support in place': 'teal', Resolved: 'good', 'Not needed': 'out' }
