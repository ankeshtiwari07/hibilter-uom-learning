import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Icon } from '../../components/Icon'
import { AiTag, Badge, Bar, Card, Empty, ErrorBox, Kpi, LineChart, Loading, Note, PageHead } from '../../components/ui'
import { get } from '../../lib/api'
import { fmtDate } from '../../lib/format'
import { ALL_SCOPE, GroupBars, n0, n1, qs, Scope, ScopeBar, Tip, useMeta } from './shared'

type Overview = {
  kpis: { learners: number; active: number; active_pct: number | null; completion: number | null; mark: number | null; overdue: number; flagged: number; graded_n: number; graded_mean: number | null; enrolments: number }
  faculties: { id: string; short: string; learners: number; active: number | null; completion: number | null; mark: number | null; overdue: number }[]
  courses: { id: string; code: string; title: string; faculty: string; lecturer: string | null; learners: number; completion: number | null; mark: number | null; overdue: number; graded_n: number; active: number | null; vf: boolean }[]
  trend: { week: string; start: string; active: number; active_pct: number; submissions: number }[]
  term: string; vf: { sessions: number; completed: number; learners: number; completion: number | null; first_try: number | null; assisted: number; open_reviews: number }
  alerts: { kind: string; text: string; link: string | null }[]; summary: string; definitions: Record<string, string>; generated_at: string
}

export default function AdminDashboard() {
  const meta = useMeta()
  const [scope, setScope] = useState<Scope>(ALL_SCOPE)
  const q = useQuery({ queryKey: ['admin-overview', scope], queryFn: () => get<Overview>('/api/admin/overview' + qs(scope)), placeholderData: p => p })
  const d = q.data, k = d?.kpis, D = d?.definitions || {}
  return <>
    <PageHead no={21} title="Institutional overview" sub="Learning activity, completion and outcomes across faculties — for academic leadership. All figures are synthetic and illustrative."
      actions={<><Link className="btn" to="/a-reports"><Icon n="csv" />Reports</Link><Link className="btn pri" to="/a-risk"><Icon n="flag" />Learners for follow-up</Link></>} />
    <ScopeBar prefix="ad" meta={meta.data} value={scope} onChange={setScope} />
    {q.isLoading ? <Loading label="Calculating institutional figures…" /> : q.error ? <ErrorBox error={q.error} retry={() => q.refetch()} /> : !d || !k ? null : !k.learners ? <Empty icon="chart" title="No learners in this scope">There are no active enrolments for the selected faculty, programme and semester. Choose a wider scope.</Empty> : <div className="stack" style={{ opacity: q.isFetching ? .6 : 1 }}>
      <div className="g g6">
        <Kpi label="Total learners" value={k.learners.toLocaleString()} delta={`${k.enrolments.toLocaleString()} enrolments`} tip={D.learners} />
        <Kpi label="Active learners" value={k.active.toLocaleString()} delta={`${n0(k.active_pct, '%')} weekly active`} tip={D.active} />
        <Kpi label="Course completion" value={n0(k.completion, '%')} delta="average progress" tip={D.completion} />
        <Kpi label="Assessment performance" value={n0(k.mark, '%')} delta={k.graded_n ? `${k.graded_n} graded · mean ${n0(k.graded_mean, '%')}` : 'no graded work yet'} tip={D.mark} />
        <Kpi label="Overdue submissions" value={k.overdue} delta="past due, not submitted" tip={D.overdue} />
        <Kpi label="Flagged for review" value={k.flagged} delta={<Link to="/a-risk">Review list →</Link>} tip={D.flagged} />
      </div>
      <div className="g g-21">
        <Card title={<>Weekly active learners <Tip text="Distinct learners in scope with at least one recorded activity (lesson view, quiz, forum, classroom, submission or sign-in) each week." /></>} actions={<span className="xs muted">{d.term}</span>}>
          {d.trend.length ? <LineChart labels={d.trend.map((t, i) => fmtDate(t.start) + (i === d.trend.length - 1 ? '*' : ''))} max={100}
            series={[{ name: 'Weekly active %', color: 'var(--c2)', data: d.trend.map(t => Math.round(t.active_pct)) }, { name: 'Target 80%', color: 'var(--c3)', data: d.trend.map(() => 80) }]} />
            : <Empty title="No weekly activity recorded yet" />}
          <p className="xs muted">* Week to date (incomplete).</p>
        </Card>
        <Card title="Automated summary" actions={<AiTag label="Auto-generated" />}>
          <p className="small">{d.summary}</p>
          <p className="xs muted" style={{ marginTop: 8 }}>Generated from the figures on this page by a fixed template (no external AI). Check before sharing.</p>
        </Card>
      </div>
      <div className="g g2">
        <Card title="Faculty comparison">
          {d.faculties.length ? <GroupBars labels={d.faculties.map(f => f.short.split(/[ &]/)[0])}
            series={[{ name: 'Completion %', color: 'var(--c1)', data: d.faculties.map(f => f.completion) }, { name: 'Avg mark %', color: 'var(--c2)', data: d.faculties.map(f => f.mark) }, { name: 'Weekly active %', color: 'var(--c3)', data: d.faculties.map(f => f.active) }]} />
            : <Empty title="No faculty data" />}
        </Card>
        <Card title="Virtual faculty pilot" actions={<AiTag label="Digital lecturers" />}>
          <div className="g g2" style={{ gap: 10 }}>
            <Kpi label="Sessions" value={d.vf.sessions.toLocaleString()} delta={`${d.vf.learners} learners`} />
            <Kpi label="Completed" value={n0(d.vf.completion, '%')} delta={`${d.vf.completed} sessions`} />
            <Kpi label="First-try correct" value={n0(d.vf.first_try, '%')} delta="checkpoint answers" />
            <Kpi label="Assisted checkpoints" value={d.vf.assisted} delta={`${d.vf.open_reviews} awaiting lecturer review`} />
          </div>
          <p className="xs muted" style={{ marginTop: 8 }}>{D.vf} Assisted checkpoints are always reviewed by the human course lecturer.</p>
        </Card>
      </div>
      {d.alerts.length > 0 && <Card title="Alerts" actions={<Badge kind="warn">{d.alerts.length}</Badge>}>
        <div className="list">{d.alerts.slice(0, 8).map((a, i) => <div className="li" key={i}>
          <span className={`ic ${a.kind === 'bad' ? 'bad' : a.kind === 'warn' ? 'warn' : 'teal'}`}><Icon n={a.kind === 'info' ? 'info' : 'alert'} /></span>
          <div className="bd"><div className="small">{a.text}</div></div>
          {a.link && <Link className="btn sm ghost" to={a.link}>Open</Link>}</div>)}</div>
      </Card>}
      <Card title="Course comparison" actions={<span className="xs muted">Sorted by completion</span>}>
        <div className="tbl-wrap"><table className="t"><thead><tr><th>Course</th><th className="adm-hide-sm">Faculty</th><th className="n">Learners</th><th>Completion</th><th className="n">Avg mark</th><th className="n adm-hide-sm">Weekly active</th><th className="n adm-hide-sm">Overdue</th></tr></thead>
          <tbody>{d.courses.map(c => <tr key={c.id}>
            <td><b>{c.code}</b> {c.title}{c.vf && <> <Badge kind="teal">VF</Badge></>}<div className="xs muted">{c.lecturer || 'No lecturer assigned'}</div></td>
            <td className="small adm-hide-sm">{c.faculty}</td><td className="n">{c.learners}</td>
            <td style={{ minWidth: 140 }}><div className="row" style={{ flexWrap: 'nowrap' }}><Bar v={c.completion || 0} kind={(c.completion ?? 100) < 50 ? 'warn' : ''} /><span className="num small">{n0(c.completion, '%')}</span></div></td>
            <td className="n">{n1(c.mark, '%')}</td><td className="n adm-hide-sm">{n0(c.active, '%')}</td><td className="n adm-hide-sm">{c.overdue || '—'}</td></tr>)}</tbody></table></div>
      </Card>
      <Note>Definitions are shown on each figure (ⓘ). Generated {fmtDate(d.generated_at, true)}. Synthetic data for demonstration — not official University of Mauritius figures.</Note>
    </div>}
  </>
}
