import { useQuery } from '@tanstack/react-query'
import { ReactNode, useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Icon } from '../../components/Icon'
import { Avatar, Badge, Card, Empty, ErrorBox, Loading, PageHead } from '../../components/ui'
import { get } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { fmtDate } from '../../lib/format'

type R = {
  q: string
  courses: { id: string; code: string; title: string; enrolled: boolean; link: string }[]
  lessons: { id: string; title: string; type: string; module: string; course_code?: string; link?: string | null }[]
  announcements: { id: string; title: string; body: string; at: string; course_code?: string; link: string }[]
  people: { id: string; name: string; role: string; title?: string; email?: string; teaches: string[]; student_no?: string; link?: string }[]
}
const ICON: Record<string, string> = { virtual: 'cap', video: 'play', reading: 'book', quiz: 'checkc', assignment: 'clip' }

function Hit({ to, icon, kind = '', title, desc, right }: { to?: string | null; icon: ReactNode; kind?: string; title: ReactNode; desc?: ReactNode; right?: ReactNode }) {
  const nav = useNavigate()
  const body = <><div className={`ic ${kind}`}>{icon}</div><div className="bd"><div className="tt">{title}</div>{desc && <div className="ds">{desc}</div>}</div>{right}</>
  return to ? <a className="li" href={to} onClick={e => { e.preventDefault(); nav(to) }} style={{ textDecoration: 'none', color: 'inherit' }}>{body}</a> : <div className="li">{body}</div>
}

export default function Search() {
  const [sp, setSp] = useSearchParams(); const { me } = useAuth()
  const q = (sp.get('q') || '').trim()
  const [v, setV] = useState(q)
  useEffect(() => setV(q), [q])
  const r = useQuery({ queryKey: ['search', q], queryFn: () => get<R>(`/api/search?q=${encodeURIComponent(q)}`), enabled: q.length >= 2 })
  const total = r.data ? r.data.courses.length + r.data.lessons.length + r.data.announcements.length + r.data.people.length : 0
  const peopleTitle = me?.role === 'student' ? 'Lecturers & staff' : me?.role === 'lecturer' ? 'Students in your courses & staff' : 'People'
  return <>
    <PageHead title="Search" sub={q ? `Results for “${q}”` : 'Search courses, lessons, announcements and people.'} />
    <form className="row" style={{ flexWrap: 'nowrap', maxWidth: 640 }} role="search" onSubmit={e => { e.preventDefault(); if (v.trim()) setSp({ q: v.trim() }) }}>
      <input className="inp" aria-label="Search" placeholder="Search courses, lessons, people…" value={v} onChange={e => setV(e.target.value)} maxLength={100} />
      <button className="btn pri"><Icon n="search" />Search</button></form>
    {q.length < 2 ? <Empty icon="search" title="Type at least two characters" />
      : r.isLoading ? <Loading label="Searching…" /> : r.error ? <ErrorBox error={r.error} retry={() => r.refetch()} />
        : !total ? <Empty icon="search" title={`No results for “${q}”`}>Check the spelling or try a course code such as HB-AI101.</Empty> : <>
          <p className="small muted" aria-live="polite">{total} result{total === 1 ? '' : 's'}</p>
          <div className="g g2">
            {r.data!.courses.length > 0 && <Card title={`Courses (${r.data!.courses.length})`}><div className="list">{r.data!.courses.map(c => <Hit key={c.id} to={c.link} icon={<Icon n="book" />} title={`${c.code} · ${c.title}`}
              right={me?.role === 'student' ? (c.enrolled ? <Badge kind="good">Enrolled</Badge> : <Badge kind="out">Available</Badge>) : undefined} />)}</div></Card>}
            {r.data!.lessons.length > 0 && <Card title={`Lessons (${r.data!.lessons.length})`}><div className="list">{r.data!.lessons.map(l => <Hit key={`${l.course_code}-${l.id}`} to={l.link} kind={l.type === 'virtual' ? 'teal' : ''}
              icon={<Icon n={ICON[l.type] || 'file'} />} title={l.title} desc={`${l.course_code || ''} · ${l.module} · ${l.type}`} />)}</div></Card>}
            {r.data!.announcements.length > 0 && <Card title={`Announcements (${r.data!.announcements.length})`}><div className="list">{r.data!.announcements.map(a => <Hit key={a.id} to={a.link} kind="gold" icon={<Icon n="mega" />}
              title={a.title} desc={<>{a.course_code ? `${a.course_code} · ` : ''}{fmtDate(a.at)} · {a.body}</>} />)}</div></Card>}
            {r.data!.people.length > 0 && <Card title={`${peopleTitle} (${r.data!.people.length})`}><div className="list">{r.data!.people.map(p => <Hit key={p.id} to={p.link} icon={<Avatar name={p.name} kind={p.role === 'student' ? '' : 't'} />}
              title={p.name} desc={<>{p.title || (p.role === 'student' ? `Student${p.student_no ? ` · ${p.student_no}` : ''}` : p.role)}{p.teaches.length ? ` · teaches ${p.teaches.join(', ')}` : ''}{p.email ? ` · ${p.email}` : ''}</>} />)}</div></Card>}
          </div>
          {me?.role === 'student' && <p className="xs muted">Search covers published courses, lessons in your enrolled courses, announcements you can see and university staff. <Link to="/s-catalogue">Browse the full catalogue</Link></p>}
        </>}
  </>
}
