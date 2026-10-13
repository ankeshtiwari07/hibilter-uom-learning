import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Icon } from '../../components/Icon'
import { Avatar, Badge, Card, Empty, ErrorBox, HBars, Kpi, LineChart, Loading, Note, PageHead } from '../../components/ui'
import { get } from '../../lib/api'
import { fmtDate, rel } from '../../lib/format'
import { greeting } from './shared'

const KIND_IC: Record<string, [string, string]> = { cls: ['clock', ''], due: ['clip', 'warn'], exam: ['award', 'bad'], uni: ['cal', ''], vf: ['cap', 'teal'] }
const ACT_IC: Record<string, string> = { submission: 'clip', vf: 'cap', message: 'msg' }

export default function LecturerDashboard() {
  const q = useQuery({ queryKey: ['lect-dash'], queryFn: () => get<any>('/api/lecturer/dashboard') })
  if (q.isLoading) return <Loading />
  if (q.error) return <ErrorBox error={q.error} retry={() => q.refetch()} />
  const d = q.data, k = d.kpis
  const next = k.to_grade_by?.[0]
  return <>
    <PageHead no={14} title={`${greeting()}, ${d.me.name.replace('Dr. ', 'Dr ')}`} sub={[d.me.title, d.me.faculty].filter(Boolean).join(' · ')}
      actions={<><Link className="btn" to="/l-comms"><Icon n="mega" />Post announcement</Link><Link className="btn pri" to="/l-grading"><Icon n="checkc" />Grade submissions</Link></>} />
    {!d.courses.length ? <Empty icon="book" title="No courses assigned">You aren’t the lecturer of any course this semester. Contact your faculty administrator.</Empty> : <>
      <div className="g g4">
        <Kpi label="Courses taught" value={k.courses} delta={d.courses.map((c: any) => c.code).join(' · ')} />
        <Kpi label="Enrolled students" value={k.students.toLocaleString()} delta="across your courses" tip="Distinct learners with an active enrolment in a course you teach." />
        <Kpi label="Submissions to grade" value={k.to_grade} delta={next ? `${next.title} · ${next.n}` : 'All caught up'} tip="Submitted and not yet graded." />
        <Kpi label="Virtual lessons completed" value={k.vf_completed} delta={k.vf_first_try != null ? `${k.vf_first_try}% first-try correct` : 'No sessions yet'} tip="Virtual faculty sessions in your courses that reached the recap." />
      </div>
      <div className="g g4">
        <Kpi label="Learners for follow-up" value={k.at_risk} delta="support indicators" tip="Any overdue submission, activity score under 35, inactive 9+ days, or falling marks with average under 60. For human review only." />
        <Kpi label="Average mark" value={k.avg != null ? `${k.avg}%` : '—'} delta="graded work" tip="Mean of graded and published submissions, as a percentage of each assessment’s maximum." />
        <Kpi label="VF completion" value={k.vf_completion != null ? `${k.vf_completion}%` : '—'} delta={`${k.vf_started} sessions started`} tip="Completed ÷ started virtual faculty sessions." />
        <Kpi label="VF reviews open" value={k.open_reviews} delta={<Link className="link" to="/vf-review">Review queue</Link>} tip="Assisted completions and low-confidence AI evaluations waiting for you." />
      </div>
      <div className="g g-21">
        <Card title="Course progress" actions={<Link className="link" to="/l-analytics">Class analytics</Link>}>
          <HBars rows={d.courses.map((c: any) => ({ label: `${c.code} · ${c.students} students`, value: c.progress }))} suffix="%" max={100} />
          <p className="xs muted" style={{ marginTop: 8 }}>Average learner progress through published course content.</p>
          {d.trend && <><div className="eyebrow" style={{ marginTop: 14 }}>Weekly active students · {d.trend.course}</div>
            <LineChart labels={d.trend.weeks} max={100} series={[{ name: 'Active %', color: 'var(--c2)', data: d.trend.active }]} />
            <p className="xs muted">Students with at least one learning activity in the week ÷ enrolled. The current week is in progress.</p></>}
        </Card>
        <Card title="Upcoming">
          {d.upcoming.length ? <div className="list">{d.upcoming.map((u: any, i: number) => { const [ic, cls] = KIND_IC[u.kind] || ['cal', '']; return <div className="li" key={i}>
            <div className={`ic ${cls}`}><Icon n={ic} /></div><div className="bd"><div className="tt">{u.title}</div><div className="ds">{fmtDate(u.at, true)}{u.location ? ` · ${u.location}` : ''}</div></div></div> })}</div>
            : <Empty icon="cal" title="Nothing scheduled">No classes or deadlines in the next 10 days.</Empty>}
        </Card>
      </div>
      <div className="g g3">
        <Card title="Recent activity">
          {d.activity.length ? <div className="list">{d.activity.map((a: any, i: number) => <Link className="li" to={a.link} key={i} style={{ color: 'inherit', textDecoration: 'none' }}>
            <div className="ic"><Icon n={ACT_IC[a.kind] || 'dot'} /></div><div className="bd"><div className="tt small">{a.text}</div><div className="ds">{rel(a.at)}</div></div></Link>)}</div>
            : <Empty title="No recent activity" />}
        </Card>
        <Card title="Learners for follow-up" actions={<Link className="link" to="/l-analytics">View all</Link>}>
          {d.follow_up.length ? <div className="list">{d.follow_up.slice(0, 5).map((f: any) => <div className="li" key={f.id}><Avatar name={f.name} />
            <div className="bd"><div className="tt">{f.name}</div><div className="ds">{f.reasons.join(' · ')}</div></div></div>)}</div>
            : <Empty icon="checkc" title="No one flagged">No learners currently meet the follow-up rules.</Empty>}
          <p className="xs muted" style={{ marginTop: 6 }}>Support indicators for human review — not predictions.</p>
        </Card>
        <Card title="Virtual faculty today" actions={<Link className="link" to="/vf-analytics">Analytics</Link>}>
          {d.vf_today.length ? <div className="list">{d.vf_today.map((s: any) => <div className="li" key={s.id}><Avatar name={s.name} kind="t" />
            <div className="bd"><div className="tt">{s.name} · {s.status}</div><div className="ds">{Object.entries(s.outcome).map(([id, o]) => `${id.toUpperCase()} ${o}`).join(' · ') || 'No checkpoints yet'} · {rel(s.at)}</div></div>
            <Badge kind={s.status === 'completed' ? 'good' : 'warn'}>{s.status === 'completed' ? 'done' : 'live'}</Badge></div>)}</div>
            : <Empty icon="cap" title="No sessions in the last day">Sessions appear here as students finish or save them.</Empty>}
          {k.open_reviews > 0 && <Note kind="warn" icon="flag">{k.open_reviews} checkpoint{k.open_reviews > 1 ? 's' : ''} completed with assisted learning or low-confidence evaluation — <Link className="link" to="/vf-review">review them</Link>.</Note>}
        </Card>
      </div>
      <div className="row"><Link className="btn" to="/l-courses"><Icon n="layers" />Manage courses</Link><Link className="btn" to="/l-builder"><Icon n="plus" />New assessment</Link>
        <Link className="btn" to="/l-editor"><Icon n="edit" />Edit a lesson</Link><Link className="btn teal" to="/vf-config"><Icon n="cap" />Configure virtual faculty</Link></div>
    </>}
  </>
}
