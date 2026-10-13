/* Helpers shared by the student portal pages. */
import { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon } from '../../components/Icon'
import { Badge, Bar } from '../../components/ui'
import { daysTo } from '../../lib/format'

export type CourseCard = {
  id: string; code: string; title: string; description: string; cover: number; credits: number; term: string; faculty: string; faculty_name: string
  faculty_id: string; programme_id?: string; lecturer?: string; weeks?: number; format: string; outcomes: string[]; vf: boolean; vf_avatar?: string
  vf_name?: string; enrolled: boolean; progress: number | null; requested?: boolean
}

export const cover = (n?: number) => `cv-${((((n || 1) - 1) % 6) + 6) % 6 + 1}`

export function CourseTile({ c, onOpen, children }: { c: CourseCard; onOpen?: () => void; children?: ReactNode }) {
  const nav = useNavigate()
  const open = onOpen || (() => nav(c.enrolled ? `/s-course/${c.id}` : '/s-catalogue'))
  return <article className="ccard" tabIndex={0} role="link" aria-label={c.title} onClick={open} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), open())}>
    <div className={`cv ${cover(c.cover)}`}><span className="code">{c.code}</span><span className="fac">{c.faculty}</span></div>
    <div className="bd"><div className="tt">{c.title}</div>
      {children ?? <><div className="xs muted">{c.lecturer || 'Lecturer to be confirmed'} · {c.format}</div>
        <div className="row" style={{ marginTop: 'auto', flexWrap: 'nowrap' }}><Bar v={c.progress ?? 0} /><span className="xs num">{c.progress ?? 0}%</span></div></>}
    </div>
  </article>
}

export function dueLabel(due?: string | null) {
  const d = daysTo(due)
  if (d == null) return 'No deadline'
  if (d < 0) return `${-d} day${d === -1 ? '' : 's'} ago`
  if (d === 0) return 'Today'
  if (d === 1) return 'Tomorrow'
  return `${d} days`
}

export function DueBadge({ due }: { due?: string | null }) {
  const d = daysTo(due)
  return <Badge kind={d == null ? 'out' : d < 0 ? 'bad' : d <= 2 ? 'warn' : 'out'}>{dueLabel(due)}</Badge>
}

export const itemIcon: Record<string, string> = { virtual: 'cap', video: 'play', reading: 'book', quiz: 'checkc', assignment: 'clip', lab: 'clip', exam: 'award' }

export function StatusBadge({ s }: { s: string }) {
  const m: Record<string, [string, string]> = {
    done: ['good', 'Completed'], progress: ['warn', 'In progress'], todo: ['out', 'Not started'],
    graded: ['good', 'Marked'], submitted: ['info', 'Submitted'], late: ['warn', 'Submitted late'], draft: ['out', 'Draft saved'],
    not_submitted: ['out', 'Not submitted'], overdue: ['bad', 'Overdue'], open: ['warn', 'Open'], closed: ['out', 'Closed'], upcoming: ['out', 'Upcoming'],
    in_progress: ['warn', 'In progress'], completed: ['good', 'Completed'],
  }
  const [k, l] = m[s] || ['out', s]
  return <Badge kind={k}>{l}</Badge>
}

export function greeting(d = new Date()) {
  const h = d.getHours()
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

export const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`

export function LinkRow({ to, icon, kind = '', title, desc, right }: { to: string; icon: string; kind?: string; title: ReactNode; desc?: ReactNode; right?: ReactNode }) {
  const nav = useNavigate()
  return <a className="li" href={to} onClick={e => { e.preventDefault(); nav(to) }} style={{ textDecoration: 'none', color: 'inherit' }}>
    <div className={`ic ${kind}`}><Icon n={icon} /></div><div className="bd"><div className="tt">{title}</div>{desc && <div className="ds">{desc}</div>}</div>{right ?? <Icon n="chev" />}</a>
}

/** Validation errors from FastAPI (422 lists) → readable text. */
export function errText(e: any): string {
  const d = e?.body?.detail
  if (Array.isArray(d)) return d.map((x: any) => x?.msg?.replace(/^Value error, /, '')).filter(Boolean).join(' ')
  return e?.message || 'Something went wrong. Try again.'
}

/** Idempotency key (crypto.randomUUID needs a secure context). */
export const rid = () => (globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`)
