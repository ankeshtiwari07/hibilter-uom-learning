/* Shared helpers for the lecturer portal pages. */
import { useQuery } from '@tanstack/react-query'
import { ReactNode } from 'react'
import { Icon } from '../../components/Icon'
import { get } from '../../lib/api'

export type CourseLite = { id: string; code: string; title: string; status: string; vf_enabled: boolean; students: number; progress: number; outcomes: string[]; description: string; modules?: number; lessons?: number; assessments?: number }

export function useMyCourses() {
  return useQuery({ queryKey: ['lect-courses'], queryFn: () => get<CourseLite[]>('/api/lecturer/courses') })
}

export function Sel({ id, label, value, onChange, options, hint }: { id: string; label: string; value: string; onChange: (v: string) => void; options: [string, string][]; hint?: string }) {
  return <div className="field"><label htmlFor={id}>{label}</label>
    <select className="inp" id={id} value={value} onChange={e => onChange(e.target.value)}>{options.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
    {hint && <span className="hint">{hint}</span>}</div>
}

export function ErrList({ errors }: { errors: string[] }) {
  if (!errors.length) return null
  return <div className="note bad" role="alert"><Icon n="alert" /><div><b>Fix before continuing:</b><ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{errors.map((e, i) => <li key={i}>{e}</li>)}</ul></div></div>
}

export function InlineErr({ msg }: { msg?: string | null }) {
  return msg ? <span className="err" role="alert"><Icon n="alert" />{msg}</span> : null
}

export function DemoTag({ children = 'Synthetic data' }: { children?: ReactNode }) { return <span className="demo-tag">{children}</span> }

export const greeting = () => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening' }

/** datetime-local <input> value from an ISO string, in the browser's local time. */
export function toLocalInput(iso?: string | null) {
  if (!iso) return ''
  const d = new Date(iso); const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}
export function fromLocalInput(v: string) { return v ? new Date(v).toISOString() : null }

export const STATUS_BADGE: Record<string, [string, string]> = {
  submitted: ['teal', 'To grade'], late: ['bad', 'Late'], missing: ['bad', 'Missing'], pending: ['out', 'Not submitted'],
  graded: ['warn', 'Draft grade'], published: ['good', 'Published'],
}

export function ListEditor({ items, onChange, placeholder, label, max = 12 }: { items: string[]; onChange: (v: string[]) => void; placeholder: string; label: string; max?: number }) {
  return <div className="col">
    {items.map((o, i) => <div className="row" style={{ flexWrap: 'nowrap' }} key={i}>
      <input className="inp" value={o} aria-label={`${label} ${i + 1}`} onChange={e => onChange(items.map((x, k) => k === i ? e.target.value : x))} />
      <button type="button" className="iconbtn" aria-label={`Remove ${label.toLowerCase()} ${i + 1}`} onClick={() => onChange(items.filter((_, k) => k !== i))}><Icon n="x" /></button>
    </div>)}
    {items.length < max && <button type="button" className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => onChange([...items, ''])}><Icon n="plus" />{placeholder}</button>}
  </div>
}
