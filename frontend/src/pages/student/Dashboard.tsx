import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { Icon } from '../../components/Icon'
import { Avatar, Bar, Card, Empty, ErrorBox, Kpi, Loading, PageHead, Ring } from '../../components/ui'
import { get } from '../../lib/api'
import { fmtDate } from '../../lib/format'
import { CourseCard, CourseTile, DueBadge, LinkRow, greeting } from './shared'

type Dash = {
  profile: { name: string; first: string; student_no?: string; year?: number; programme?: string; faculty?: string }
  term?: string; courses: CourseCard[]
  kpis: { courses: number; completion: number; due_week: number; average: number | null; graded_count: number; unread: number }
  deadlines: { id: string; title: string; type: string; due: string; course_code: string; link: string }[]
  events: { id: string; kind: string; title: string; start: string; end?: string }[]
  announcements: { id: string; title: string; scope: string; course_code?: string; at: string; unread: boolean }[]
  hero: null | { lesson_id: string; title: string; module: string; course_code: string; dur: number; checkpoints: number; status: string; saved_at?: string; pct: number
    avatar?: { id: string; name: string; portrait: string; pos?: string }; next?: { title: string; link: string } | null }
  recent: { icon: string; title: string; desc: string; link: string; at: string }[]
  recommendations: { title: string; why: string; link: string; icon: string }[]
}

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString()
const hm = (s?: string) => s ? new Date(s).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : ''

export default function Dashboard() {
  const nav = useNavigate()
  const q = useQuery({ queryKey: ['s-dash'], queryFn: () => get<Dash>('/api/student/dashboard') })
  if (q.isLoading) return <Loading label="Loading your dashboard…" />
  if (q.error) return <ErrorBox error={q.error} retry={() => q.refetch()} />
  const d = q.data!
  const now = new Date()
  const today = d.events.filter(e => sameDay(new Date(e.start), now))
  const h = d.hero
  const heroLink = h ? (h.status === 'done' ? h.next?.link || `/s-course` : `/s-classroom/${h.lesson_id}${h.avatar ? `?avatar=${h.avatar.id}` : ''}`) : '/s-course'
  const sub = `${now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}${d.term ? ` · ${d.term}` : ''}${d.profile.programme ? ` · ${d.profile.programme}` : ''}${d.profile.year ? `, Year ${d.profile.year}` : ''}`
  return <>
    <PageHead no={2} title={`${greeting()}, ${d.profile.first}`} sub={sub}
      actions={<><Link className="btn" to="/s-cal"><Icon n="cal" />Timetable</Link><button className="btn teal" onClick={() => nav(heroLink)}><Icon n="playc" />Continue learning</button></>} />

    <div className="g g4">
      <Kpi label="Enrolled courses" value={d.kpis.courses} delta={`${d.kpis.completion}% average completion`} tip="Completed lessons and activities ÷ all published ones, across your enrolled courses." />
      <Kpi label="Due in the next 7 days" value={d.kpis.due_week} delta={d.kpis.due_week ? 'Not yet submitted' : 'Nothing due this week'} up={d.kpis.due_week === 0 ? true : undefined} />
      <Kpi label="Average mark" value={d.kpis.average == null ? '—' : `${d.kpis.average}%`} delta={d.kpis.graded_count ? `across ${d.kpis.graded_count} marked item${d.kpis.graded_count === 1 ? '' : 's'}` : 'No marks published yet'} tip="Mean of your marked assessments this semester (score ÷ maximum)." />
      <Kpi label="Unread announcements" value={d.kpis.unread} delta={<Link to="/s-news">Open announcements</Link>} />
    </div>

    <div className="g g-21">
      {h ? <div className="card hero-card"><div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
        <span className="ai-tag" style={{ alignSelf: 'flex-start' }}><Icon n="cap" />Virtual faculty lesson</span>
        <h2>{h.status === 'done' ? (h.next ? `Lesson complete — next: ${h.next.title}` : 'Lesson complete') : h.title}</h2>
        <p className="muted small">{h.course_code} · {h.module} · {h.dur} min{h.avatar ? <> · with {h.avatar.name} (digital lecturer), who will ask you {h.checkpoints} questions and wait for your answers.</> : null}</p>
        <div className="row" style={{ flexWrap: 'nowrap' }}><Bar v={h.pct} /><span className="xs muted num" style={{ whiteSpace: 'nowrap' }}>{h.status === 'done' ? 'Completed' : h.saved_at ? `Saved at ${h.saved_at}` : h.status === 'progress' ? 'Started' : 'Not started'}</span></div>
        <div className="row"><button className="btn teal" onClick={() => nav(heroLink)}><Icon n="playc" />{h.status === 'done' ? 'Next lesson' : h.saved_at ? 'Resume lesson' : 'Start lesson'}</button>
          <Link className="btn ghost" to="/s-classroom">Choose lecturer</Link></div></div>
        <div className="por" style={{ position: 'relative', background: 'linear-gradient(180deg,#3A4656,#1C2532)', minHeight: 200, overflow: 'hidden' }}>
          {h.avatar && <img src={h.avatar.portrait} alt={`${h.avatar.name}, digital lecturer`} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', objectPosition: h.avatar.pos || '50% 30%' }} />}</div></div>
        : <Card title="Continue learning"><Empty icon="cap" title="No interactive lessons yet">Your lecturers haven’t published a virtual faculty lesson for your courses. <Link to="/s-course">Open my course</Link></Empty></Card>}
      <div className="card"><div className="row" style={{ gap: 12, flexWrap: 'nowrap' }}><Avatar name={d.profile.name} kind="t" size={48} /><div style={{ minWidth: 0 }}><b>{d.profile.name}</b><div className="xs muted">{d.profile.student_no} · synthetic profile</div></div></div>
        <dl className="kv" style={{ marginTop: 12 }}><dt>Programme</dt><dd>{d.profile.programme || '—'}</dd><dt>Faculty</dt><dd>{d.profile.faculty || '—'}</dd>
          <dt>Year / semester</dt><dd>{d.profile.year ? `Year ${d.profile.year}` : '—'}{d.term ? ` · ${d.term}` : ''}</dd><dt>Courses</dt><dd>{d.courses.length} enrolled</dd></dl>
        <div className="row" style={{ marginTop: 12 }}><Ring p={d.kpis.completion} /><div className="small"><b>Overall completion</b><div className="xs muted">across enrolled courses</div></div></div></div>
    </div>

    <div><div className="row sb" style={{ marginBottom: 10 }}><h2>My courses</h2><Link to="/s-catalogue" className="small">Browse catalogue</Link></div>
      {d.courses.length ? <div className="g g4">{d.courses.map(c => <CourseTile key={c.id} c={c} />)}</div>
        : <Empty icon="book" title="You’re not enrolled in any course yet"><Link to="/s-catalogue">Browse the catalogue</Link> to request enrolment.</Empty>}</div>

    <div className="g g3">
      <Card title="Upcoming deadlines" actions={<Link className="link" to="/s-assign">All</Link>}>
        {d.deadlines.length ? <div className="list">{d.deadlines.slice(0, 4).map(a => <LinkRow key={a.id} to={a.link} icon={a.type === 'quiz' ? 'checkc' : a.type === 'exam' ? 'award' : 'clip'}
          title={a.title} desc={`${a.course_code} · ${fmtDate(a.due, true)}`} right={<DueBadge due={a.due} />} />)}</div>
          : <Empty icon="checkc" title="No upcoming deadlines">You’re all caught up.</Empty>}</Card>
      <Card title="Today" actions={<span className="xs muted">{now.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}</span>}>
        {today.length ? <div className="list">{today.map(e => <div className="li" key={e.id}><div className={`ic ${e.kind === 'vf' ? 'teal' : e.kind === 'due' ? 'warn' : e.kind === 'exam' ? 'bad' : ''}`}><Icon n={e.kind === 'vf' ? 'cap' : e.kind === 'due' ? 'clip' : 'clock'} /></div>
          <div className="bd"><div className="tt">{e.title}</div><div className="ds">{hm(e.start)}{e.end && e.end !== e.start ? `–${hm(e.end)}` : ''}</div></div></div>)}</div>
          : <Empty icon="cal" title="Nothing scheduled today"><Link to="/s-cal">Open the timetable</Link></Empty>}</Card>
      <Card title="Announcements" actions={<Link className="link" to="/s-news">All</Link>}>
        {d.announcements.length ? <div className="list">{d.announcements.map(n => <div key={n.id} className={`li ${n.unread ? 'unread' : ''}`}><div className="bd"><div className="tt">{n.title}</div>
          <div className="ds">{n.scope === 'uni' || n.scope === 'university' ? 'University notice' : n.course_code || 'Faculty notice'} · {fmtDate(n.at)}</div></div></div>)}</div>
          : <Empty icon="mega" title="No announcements" />}</Card>
    </div>

    <div className="g g2">
      <Card title="Recently accessed">
        {d.recent.length ? <div className="list">{d.recent.map((r, i) => <LinkRow key={i} to={r.link} icon={r.icon} title={r.title} desc={r.desc} />)}</div>
          : <Empty icon="play" title="Nothing opened yet">Lessons, quizzes and assignments you open will appear here.</Empty>}</Card>
      <Card title="Recommended for you" actions={<span className="b info">Rule-based</span>}>
        {d.recommendations.length ? <div className="list">{d.recommendations.map((r, i) => <LinkRow key={i} to={r.link} kind="teal" icon="bulb" title={r.title} desc={r.why} />)}</div>
          : <Empty icon="bulb" title="No suggestions right now">Suggestions appear after your first quiz or lesson.</Empty>}
        <p className="xs muted" style={{ marginTop: 8 }}>Why these? Each suggestion states the rule that triggered it — your recent answers, deadlines and unfinished lessons. Recommendations never affect grades.</p></Card>
    </div>
  </>
}
