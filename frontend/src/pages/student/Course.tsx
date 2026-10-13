import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { Icon } from '../../components/Icon'
import { Avatar, Badge, Bar, Card, Empty, ErrorBox, Loading, Tabs } from '../../components/ui'
import { get } from '../../lib/api'
import { fmtDate, rel } from '../../lib/format'
import { CourseCard, StatusBadge, cover, itemIcon } from './shared'
import { ComposeModal, ThreadList, ThreadModal, ThreadRow } from './threads'

type Item = { id: string; title: string; type: string; dur?: number; vf: boolean; status: string; link: string | null; lesson_id?: string }
type Detail = {
  course: CourseCard & { lecturer_title?: string; lecturer_email?: string }
  modules: { id: string; title: string; items: Item[] }[]; done: number; total: number
  assessments: { id: string; title: string; type: string; weight: number; due?: string; status: string; score?: number | null; max: number; link?: string | null }[]
  announcements: { id: string; title: string; body: string; by: string; at: string; unread: boolean }[]
  threads: ThreadRow[]; resources: { id: string; title: string; kind: string; uri?: string | null }[]
}

export default function Course() {
  const { courseId } = useParams()
  const mine = useQuery({ queryKey: ['s-courses'], queryFn: () => get<CourseCard[]>('/api/student/courses') })
  if (!courseId) {
    if (mine.isLoading) return <Loading />
    if (mine.error) return <ErrorBox error={mine.error} retry={() => mine.refetch()} />
    if (!mine.data?.length) return <Empty icon="book" title="You’re not enrolled in any course yet"><Link to="/s-catalogue">Browse the catalogue</Link></Empty>
    return <Navigate replace to={`/s-course/${mine.data[0].id}`} />
  }
  return <CourseView id={courseId} mine={mine.data || []} />
}

function CourseView({ id, mine }: { id: string; mine: CourseCard[] }) {
  const nav = useNavigate()
  const q = useQuery({ queryKey: ['s-course', id], queryFn: () => get<Detail>(`/api/student/courses/${id}`) })
  const [tab, setTab] = useState('ann')
  const [thread, setThread] = useState<string | null>(null)
  const [compose, setCompose] = useState(false)
  if (q.isLoading) return <Loading label="Loading course…" />
  if (q.error) return <ErrorBox error={q.error} retry={() => q.refetch()} />
  const d = q.data!, c = d.course
  const vfFirst = d.modules.flatMap(m => m.items).find(i => i.vf && i.link && i.status !== 'done') || d.modules.flatMap(m => m.items).find(i => i.vf && i.link)
  const go = (i: Item) => i.link && nav(i.link)
  return <>
    {mine.length > 1 && <div className="row sb"><label className="small muted" htmlFor="co-sw">Switch course</label>
      <select id="co-sw" className="inp" style={{ width: 'auto', maxWidth: '100%' }} value={id} onChange={e => nav(`/s-course/${e.target.value}`)}>
        {mine.map(m => <option key={m.id} value={m.id}>{m.code} · {m.title}</option>)}</select></div>}
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div className={cover(c.cover)} style={{ padding: '22px 24px', color: '#fff', display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div style={{ flex: 1, minWidth: 0 }}><div className="mono" style={{ opacity: .8 }}>{c.code} · {c.faculty_name}</div>
          <h1 style={{ color: '#fff', marginTop: 6 }}>{c.title}<span className="screen-no" style={{ color: '#cbd5e1', borderColor: 'rgba(255,255,255,.3)' }}>S04</span></h1>
          <p style={{ opacity: .85, marginTop: 6, maxWidth: '70ch' }}>{c.description}</p></div>
        <div className="row">{vfFirst && <button className="btn teal" onClick={() => go(vfFirst)}><Icon n="cap" />{vfFirst.status === 'done' ? 'Revisit virtual lesson' : vfFirst.status === 'progress' ? 'Resume virtual lesson' : 'Start virtual lesson'}</button>}
          <button className="btn" onClick={() => nav(`/s-ai?course=${c.id}`)} style={{ background: 'rgba(255,255,255,.1)', color: '#fff', borderColor: 'rgba(255,255,255,.3)' }}><Icon n="ai" />Ask the study assistant</button></div>
      </div>
      <div className="row" style={{ padding: '12px 24px', gap: 22, flexWrap: 'wrap' }}>
        <span className="small"><Icon n="user" /> {c.lecturer || 'Lecturer to be confirmed'}</span>
        <span className="small">{c.credits} credits{c.weeks ? ` · ${c.weeks} weeks` : ''} · {c.format}</span>
        <span className="row small" style={{ gap: 8, flex: 1, minWidth: 200, flexWrap: 'nowrap' }}>Your progress <Bar v={c.progress ?? 0} /><b className="num">{c.progress ?? 0}%</b></span>
      </div>
    </div>

    <div className="g g-21"><div className="stack">
      <Card title="Modules" actions={<span className="xs muted">{d.modules.length} modules · {d.done}/{d.total} done</span>}>
        {d.modules.length ? <div className="col">{d.modules.map((m, mi) => <details key={m.id} open={mi < 2} className="spec">
          <summary><span className="n">M{mi + 1}</span><b>{m.title}</b><span className="xs muted">{m.items.filter(i => i.status === 'done').length}/{m.items.length} done</span></summary>
          <div style={{ padding: '6px 14px' }}>{m.items.map(i => {
            const inner = <><div className={`ic ${i.vf ? 'teal' : ''}`}><Icon n={itemIcon[i.type] || 'file'} /></div>
              <div className="bd"><div className="tt">{i.title}</div><div className="ds">{i.vf ? 'Virtual faculty · interactive · ' : `${i.type.charAt(0).toUpperCase() + i.type.slice(1)} · `}{i.dur ? `${i.dur} min` : ''}</div></div>
              <StatusBadge s={i.status} /></>
            return i.link ? <a key={i.id} className="li" href={i.link} onClick={e => { e.preventDefault(); go(i) }} style={{ textDecoration: 'none', color: 'inherit', alignItems: 'center' }}>{inner}</a>
              : <div key={i.id} className="li" style={{ alignItems: 'center', opacity: .7 }} title="Not available yet">{inner}</div>
          })}</div></details>)}</div>
          : <Empty icon="layers" title="No published modules yet">Your lecturer hasn’t published content for this course.</Empty>}
      </Card>
      <div className="card"><div className="hd"><Tabs tabs={[['ann', `Announcements (${d.announcements.length})`], ['disc', `Discussion (${d.threads.length})`]]} value={tab} onChange={setTab} /></div>
        {tab === 'ann' ? (d.announcements.length ? <div className="list">{d.announcements.map(n => <div key={n.id} className={`li ${n.unread ? 'unread' : ''}`}><div className="ic teal"><Icon n="mega" /></div>
          <div className="bd"><div className="tt">{n.title}</div><div className="ds">{n.body}</div><div className="xs muted">{n.by} · {rel(n.at)}</div></div></div>)}</div>
          : <Empty icon="mega" title="No course announcements yet" />)
          : <><ThreadList rows={d.threads} onOpen={setThread} empty="No discussions yet — start one." />
            <button className="btn sm" style={{ marginTop: 8 }} onClick={() => setCompose(true)}><Icon n="plus" />New thread</button></>}
      </div>
    </div>

    <div className="stack">
      <Card title="Learning outcomes">{c.outcomes.length ? <ol className="small" style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>{c.outcomes.map(o => <li key={o}>{o}</li>)}</ol>
        : <p className="small muted">Outcomes haven’t been published.</p>}</Card>
      <Card title="Assessment breakdown">{d.assessments.length ? <><div className="tbl-wrap"><table className="t"><thead><tr><th>Item</th><th className="n">Weight</th><th>Status</th></tr></thead>
        <tbody>{d.assessments.map(a => <tr key={a.id}><td>{a.link ? <Link to={a.link}>{a.title}</Link> : a.title}<div className="xs muted">{a.due ? `Due ${fmtDate(a.due, true)}` : 'Date to be announced'}</div></td>
          <td className="n">{a.weight}%</td><td>{a.status === 'graded' && a.score != null ? <Badge kind="good">{a.score}/{a.max}</Badge> : <StatusBadge s={a.status} />}</td></tr>)}</tbody></table></div>
        <p className="xs muted" style={{ marginTop: 6 }}>Virtual-faculty checkpoints are formative and carry no marks.</p></>
        : <Empty icon="clip" title="No assessments published yet" />}</Card>
      <Card title="Lecturer"><div className="row" style={{ flexWrap: 'nowrap' }}><Avatar name={c.lecturer || '?'} kind="t" />
        <div style={{ minWidth: 0 }}><b className="small">{c.lecturer || 'To be confirmed'}</b><div className="xs muted">{d.course.lecturer_title}</div></div></div>
        <div className="row" style={{ marginTop: 10 }}><Link className="btn sm" to="/s-news?tab=msg"><Icon n="msg" />Message</Link></div></Card>
      <Card title="Resources">{d.resources.length ? <div className="list">{d.resources.map(r => <div className="li" key={r.id}><div className="ic"><Icon n="file" /></div>
        <div className="bd"><div className="tt">{r.title}</div><div className="ds">Approved course material · {r.kind}</div></div>
        {r.uri ? <a className="iconbtn" href={r.uri} target="_blank" rel="noreferrer" aria-label={`Open ${r.title}`}><Icon n="download" /></a> : <span className="xs muted">Used by the assistant</span>}</div>)}</div>
        : <Empty icon="file" title="No resources yet" />}</Card>
    </div></div>
    {thread && <ThreadModal id={thread} onClose={() => setThread(null)} />}
    {compose && <ComposeModal mode="thread" courses={[{ id: c.id, label: `${c.code} · ${c.title}` }]} onClose={() => setCompose(false)} />}
  </>
}
