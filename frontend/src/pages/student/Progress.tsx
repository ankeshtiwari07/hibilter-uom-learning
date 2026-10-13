import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Icon } from '../../components/Icon'
import { Badge, Card, Empty, ErrorBox, HBars, Kpi, LineChart, Loading, Note, PageHead } from '../../components/ui'
import { get } from '../../lib/api'
import { fmtDate } from '../../lib/format'
import { DueBadge, LinkRow } from './shared'

type Score = { id: string; title: string; type: string; course_code: string; course_id: string; weight: number; max: number; at: string; score: number; pct: number; marked_by: string }
type P = {
  kpis: { average: number | null; graded: number; completion: number; streak: number; active_days: number; vf_completed: number; vf_first_try: number; vf_total: number }
  courses: { id: string; code: string; title: string; progress: number }[]
  scores: Score[]; pending: { id: string; title: string; course_code: string; status: string; at: string; type: string }[]
  upcoming: { id: string; title: string; course_code: string; due: string; link: string; type: string }[]
  vf: { id: string; lesson_id: string; lesson: string; avatar: string; status: string; at: string; total: number
    checkpoints: { id: string; question: string; attempts: number; first?: string | null; final?: string | null; hints: number; outcome: string }[] }[]
  strengths: { label: string; detail: string }[]; improve: { label: string; detail: string; link?: string }[]
  indicators: { rule: string; detail: string }[]; timeline: { at: string; kind: string; text: string }[]
  outcomes: { course_id: string; code: string; title: string; outcomes: string[]; evidence: number; progress: number }[]
}
const VERDICT: Record<string, string> = { correct: 'good', partial: 'warn', incorrect: 'bad', unclear: 'out', empty: 'out' }

export default function Progress() {
  const q = useQuery({ queryKey: ['s-progress'], queryFn: () => get<P>('/api/student/progress') })
  if (q.isLoading) return <Loading label="Loading your progress…" />
  if (q.error) return <ErrorBox error={q.error} retry={() => q.refetch()} />
  const d = q.data!, k = d.kpis
  const fresh = !d.scores.length && !d.vf.length && !d.timeline.length
  return <>
    <PageHead no={9} title="My progress" sub="Where you are across your courses, what is going well, and what to revise next. Only you (and your lecturers) can see this." />
    {fresh && <Note>Your progress appears after your first activity — open a lesson, take a quiz or start a virtual lesson.</Note>}
    <div className="g g4">
      <Kpi label="Average assessment score" value={k.average == null ? '—' : `${k.average}%`} delta={k.graded ? `across ${k.graded} marked item${k.graded === 1 ? '' : 's'}` : 'No marks yet'} tip="Mean of your marked items this semester (best attempt per quiz)." />
      <Kpi label="Course completion" value={`${k.completion}%`} delta="lessons & activities done" tip="Completed lessons and activities ÷ all published ones, averaged across enrolled courses." />
      <Kpi label="Study streak" value={`${k.streak} day${k.streak === 1 ? '' : 's'}`} delta={`active on ${k.active_days} of last 14 days`} tip="Consecutive days with at least one recorded learning activity." />
      <Kpi label="Virtual lessons" value={`${k.vf_completed} completed`} delta={k.vf_completed ? `${k.vf_first_try}/${k.vf_total} checkpoints first try (latest)` : <Link to="/s-classroom">Start your first one</Link>} tip="Interactive lessons with a digital lecturer. Checkpoints are formative and carry no marks." />
    </div>

    <div className="g g-21">
      <Card title="Course completion">{d.courses.length ? <HBars suffix="%" max={100} rows={d.courses.map(c => ({ label: `${c.code} · ${c.title}`, value: c.progress, kind: 'c2' }))} /> : <Empty icon="book" title="No enrolled courses" />}</Card>
      <Card title={<>Support indicators <i className="info" tabIndex={0} data-tip="These are prompts to help you stay on track — not predictions or academic decisions. Lecturers review them with you.">i</i></>}>
        {d.indicators.length ? <div className="col">{d.indicators.map(x => <Note key={x.rule} kind="warn" icon="flag"><b>{x.rule}.</b> {x.detail}</Note>)}</div>
          : <Note kind="teal" icon="checkc"><b>On track.</b> No missed deadlines, recent activity, and no drop in marks.</Note>}
        <p className="xs muted" style={{ marginTop: 8 }}>Shown if you miss a deadline (last 30 days), have no activity for 10 days, or your latest mark drops more than 15 points below your earlier average.</p></Card>
    </div>

    <div className="g g2">
      <Card title="Assessment scores">{d.scores.length || d.pending.length || d.upcoming.length ? <div className="tbl-wrap"><table className="t"><thead><tr><th>Assessment</th><th>Course</th><th className="n">Score</th></tr></thead><tbody>
        {d.scores.map(s => <tr key={s.id}><td>{s.title}<div className="xs muted">{fmtDate(s.at)} · {s.marked_by === 'auto' ? 'auto-scored quiz' : 'marked by lecturer'}</div></td><td>{s.course_code}</td><td className="n">{s.score}/{s.max} <span className="xs muted">({s.pct}%)</span></td></tr>)}
        {d.pending.map(s => <tr key={'p' + s.id}><td>{s.title}</td><td>{s.course_code}</td><td className="n"><Badge kind="info">Awaiting marking</Badge></td></tr>)}
        {d.upcoming.map(s => <tr key={'u' + s.id}><td>{s.title}</td><td>{s.course_code}</td><td className="n"><Link to={s.link}>{s.type === 'quiz' ? 'Take quiz' : 'Open'}</Link> <DueBadge due={s.due} /></td></tr>)}
      </tbody></table></div> : <Empty icon="clip" title="No assessments yet" />}</Card>
      <Card title="Score trend">{d.scores.length >= 2 ? <LineChart max={100} labels={d.scores.map(s => fmtDate(s.at))} series={[{ name: 'Your mark (%)', color: 'var(--teal)', data: d.scores.map(s => s.pct) }]} />
        : <Empty icon="line" title="Not enough marks yet">Your trend appears after two marked items.</Empty>}</Card>
    </div>

    <div className="g g2">
      <Card title="Strengths and areas to improve" actions={<span className="b info" title="Generated by rules from your own answers — not by AI">Rule-based</span>}>
        {d.strengths.length || d.improve.length ? <>
          {d.strengths.map((s, i) => <div className="concept ok" key={'s' + i}><Icon n="checkc" /><span><b>{s.label}.</b> {s.detail}</span></div>)}
          {d.improve.map((s, i) => <div className="concept miss" key={'m' + i}><Icon n="dot" /><span><b>{s.label}.</b> {s.detail}</span></div>)}
          {d.improve.length > 0 && <><div className="eyebrow" style={{ marginTop: 12 }}>Recommended revision</div><div className="list">
            {d.improve.slice(0, 2).map((s, i) => <LinkRow key={i} to={s.link || '/s-ai'} kind="teal" icon="ai" title={`Ask the assistant: ${s.label.length > 60 ? s.label.slice(0, 58) + '…' : s.label}`} desc="Grounded in approved course material" />)}</div></>}</>
          : <Empty icon="target" title="Nothing to summarise yet">Strengths and gaps appear from your quiz answers and virtual-lesson checkpoints.</Empty>}</Card>
      <Card title="Learning activity">{d.timeline.length ? <div className="tl">{d.timeline.map((t, i) => <div key={i} className={`it ${t.kind}`}><b className="small">{t.text}</b><div className="xs muted">{fmtDate(t.at, true)}</div></div>)}</div>
        : <Empty icon="clock" title="No activity yet" />}</Card>
    </div>

    <Card title="Virtual faculty checkpoints" actions={<span className="xs muted">Formative — no marks</span>}>
      {d.vf.length ? <div className="col">{d.vf.map(s => <details key={s.id} className="spec" open={s === d.vf[0]}>
        <summary><span className="n"><Icon n="cap" /></span><span style={{ flex: 1, minWidth: 0 }}><b>{s.lesson}</b><span className="xs muted" style={{ display: 'block' }}>with {s.avatar} · {fmtDate(s.at)}</span></span>{s.status === 'completed' ? <Badge kind="good">Completed</Badge> : <Badge kind="warn">In progress</Badge>}</summary>
        <div style={{ padding: '6px 14px' }}>{s.checkpoints.length ? <div className="tbl-wrap"><table className="t"><thead><tr><th>Checkpoint</th><th className="n">Attempts</th><th>First try</th><th>Final</th><th className="n">Hints</th></tr></thead>
          <tbody>{s.checkpoints.map(c => <tr key={c.id}><td className="small">{c.question}</td><td className="n">{c.attempts}</td><td>{c.first ? <Badge kind={VERDICT[c.first] || 'out'}>{c.first}</Badge> : '—'}</td>
            <td>{c.outcome === 'assisted' ? <Badge kind="info">assisted</Badge> : c.final ? <Badge kind={VERDICT[c.final] || 'out'}>{c.final}</Badge> : '—'}</td><td className="n">{c.hints}</td></tr>)}</tbody></table></div>
          : <p className="small muted">No checkpoints answered yet.</p>}
          <div className="row" style={{ marginTop: 8 }}><Link className="btn sm" to={`/s-classroom/${s.lesson_id}`}><Icon n="playc" />{s.status === 'completed' ? 'Revisit lesson' : 'Resume lesson'}</Link></div></div>
      </details>)}</div> : <Empty icon="cap" title="No virtual lessons yet"><Link to="/s-classroom">Start a virtual faculty lesson</Link></Empty>}
    </Card>

    <Card title="Course learning outcomes">{d.outcomes.length ? <div className="g g2">{d.outcomes.map(o => <div key={o.course_id} className="card flat">
      <div className="row sb"><b className="small">{o.code} · {o.title}</b><Badge kind="out">{o.evidence} piece{o.evidence === 1 ? '' : 's'} of evidence</Badge></div>
      {o.outcomes.length ? <ul className="small" style={{ margin: '8px 0 0', paddingLeft: 18 }}>{o.outcomes.map(x => <li key={x}>{x}</li>)}</ul> : <p className="small muted">Outcomes not published.</p>}
      <p className="xs muted" style={{ marginTop: 6 }}>{o.progress}% of course activities complete.</p></div>)}</div> : <Empty icon="target" title="No outcomes yet" />}</Card>
  </>
}
