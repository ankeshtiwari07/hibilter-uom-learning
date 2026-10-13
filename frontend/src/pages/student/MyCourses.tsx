import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Icon } from '../../components/Icon'
import { Bar, Empty, ErrorBox, Loading, PageHead, Seg } from '../../components/ui'
import { get } from '../../lib/api'
import { CourseCard, cover, itemIcon } from './shared'

type Mine = CourseCard & {
  modules: number; done: number; total: number; minutes_left: number; counts: Record<string, number>
  next: { id: string; title: string; type: string; link: string; module: string; status: string } | null
}

const TYPE_LABEL: Record<string, string> = { virtual: 'Virtual lesson', video: 'Lecture', reading: 'Reading', quiz: 'Quiz', assignment: 'Assignment' }
const hours = (m: number) => m >= 90 ? `about ${Math.round(m / 60)} h` : `${m} min`

export default function MyCourses() {
  const nav = useNavigate()
  const q = useQuery({ queryKey: ['s-my-courses'], queryFn: () => get<Mine[]>('/api/student/my-courses') })
  const [f, setF] = useState('active')
  if (q.isLoading) return <Loading label="Loading your courses…" />
  if (q.error) return <ErrorBox error={q.error} retry={() => q.refetch()} />
  const all = q.data || []
  const isDone = (c: Mine) => c.total > 0 && c.done >= c.total
  const rows = all.filter(c => f === 'all' || (f === 'done' ? isDone(c) : !isDone(c)))
  const cont = all.filter(c => c.next).sort((a, b) => (b.next!.status === 'progress' ? 1 : 0) - (a.next!.status === 'progress' ? 1 : 0))[0]
  return <>
    <PageHead no={4} title="My courses" sub={`${all.length} enrolled course${all.length === 1 ? '' : 's'} this term`}
      actions={<Link className="btn" to="/s-catalogue"><Icon n="grid" />Browse the catalogue</Link>} />
    {!all.length ? <Empty icon="book" title="You’re not enrolled in any course yet"><Link to="/s-catalogue">Browse the catalogue</Link> to request a place.</Empty> : <>
      {cont?.next && <div className="card mc-continue"><div className={`mc-cv ${cover(cont.cover)}`}><Icon n={itemIcon[cont.next.type] || 'play'} /></div>
        <div style={{ flex: 1, minWidth: 0 }}><div className="eyebrow">{cont.next.status === 'progress' ? 'Continue where you left off' : 'Up next'} · {cont.code}</div>
          <b style={{ display: 'block', marginTop: 2 }}>{cont.next.title}</b><span className="xs muted">{cont.next.module} · {TYPE_LABEL[cont.next.type] || cont.next.type}</span></div>
        <button className="btn teal" onClick={() => nav(cont.next!.link)}><Icon n="playc" />{cont.next.status === 'progress' ? 'Resume' : 'Start'}</button></div>}
      <div className="row sb"><Seg options={[['active', 'In progress'], ['done', 'Completed'], ['all', 'All']]} value={f} onChange={setF} /><span className="xs muted">{rows.length} shown</span></div>
      {rows.length ? <div className="mc-grid">{rows.map(c => <article key={c.id} className="card mc-card">
        <Link to={`/s-course/${c.id}`} className={`mc-head ${cover(c.cover)}`} aria-label={`Open ${c.title}`}>
          <span className="mono xs">{c.code} · {c.faculty}</span><b>{c.title}</b><span className="xs" style={{ opacity: .85 }}>{c.lecturer || 'Lecturer to be confirmed'} · {c.format}</span></Link>
        <div className="mc-body">
          <div className="row" style={{ flexWrap: 'nowrap', gap: 8 }}><Bar v={c.progress ?? 0} /><b className="num small">{c.progress ?? 0}%</b></div>
          <div className="xs muted">{c.done} of {c.total} items complete · {c.modules} modules{c.minutes_left ? ` · ${hours(c.minutes_left)} left` : ''}</div>
          <div className="mc-counts">{(['virtual', 'video', 'reading', 'quiz', 'assignment'] as const).filter(k => c.counts?.[k]).map(k =>
            <span key={k} className="xs" title={TYPE_LABEL[k]}><Icon n={itemIcon[k]} />{c.counts[k]} {TYPE_LABEL[k].toLowerCase()}{c.counts[k] > 1 ? 's' : ''}</span>)}</div>
          {c.next ? <div className="mc-next"><Icon n={itemIcon[c.next.type] || 'file'} /><div style={{ minWidth: 0, flex: 1 }}><div className="xs muted">{c.next.status === 'progress' ? 'In progress' : 'Up next'}</div>
            <div className="small tt">{c.next.title}</div></div></div>
            : <div className="mc-next"><Icon n={c.total ? 'checkc' : 'clock'} /><div className="small">{c.total ? 'All items complete' : 'Your lecturer hasn’t published content yet'}</div></div>}
          <div className="row" style={{ marginTop: 'auto' }}>
            {c.next && <button className="btn sm teal" onClick={() => nav(c.next!.link)}>{c.next.status === 'progress' ? 'Resume' : 'Start'}</button>}
            <Link className="btn sm" to={`/s-course/${c.id}`}><Icon n="list" />Course content</Link></div>
        </div></article>)}</div>
        : <Empty icon="book" title={f === 'done' ? 'No completed courses yet' : 'Nothing in progress'} />}
    </>}
  </>
}
