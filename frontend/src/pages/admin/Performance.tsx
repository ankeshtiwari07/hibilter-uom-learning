import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Badge, Card, Empty, ErrorBox, HBars, Kpi, LineChart, Loading, Modal, PageHead, VBars } from '../../components/ui'
import { get } from '../../lib/api'
import { fmtDate } from '../../lib/format'
import { ALL_SCOPE, GroupBars, n0, n1, qs, Scope, ScopeBar, Sel, Tip, useMeta } from './shared'

type Perf = {
  kpis: { mark: number | null; pass: number | null; completion: number | null; active_pct: number | null; learners: number; graded_n: number; graded_mean: number | null; overdue: number }
  distribution: { label: string; value: number }[]
  courses: { id: string; code: string; title: string; faculty: string; lecturer: string | null; learners: number; completion: number | null; mark: number | null; overdue: number; graded_n: number; active: number | null; pass: number | null }[]
  faculties: { id: string; short: string; learners: number; active: number | null; completion: number | null; mark: number | null }[]
  trend: { week: string; start: string; active: number; submissions: number; graded_mean: number | null }[]
  term: string; definitions: Record<string, string>
}

export default function Performance() {
  const meta = useMeta()
  const [scope, setScope] = useState<Scope>(ALL_SCOPE)
  const [course, setCourse] = useState('all'); const [range, setRange] = useState('sem')
  const [sort, setSort] = useState<'mark' | 'completion' | 'pass' | 'learners'>('mark')
  const [drill, setDrill] = useState<string | null>(null)
  const params = { ...scope, course, range }
  const q = useQuery({ queryKey: ['admin-perf', params], queryFn: () => get<Perf>('/api/admin/performance' + qs(params)), placeholderData: p => p })
  const courses = (meta.data?.courses || []).filter(c => c.status !== 'archived' && (scope.faculty === 'all' || c.faculty_id === scope.faculty) && (scope.programme === 'all' || c.programme_id === scope.programme))
  const d = q.data, k = d?.kpis, D = d?.definitions || {}
  const rows = d ? [...d.courses].filter(c => c.learners).sort((a, b) => sort === 'learners' ? b.learners - a.learners : ((b[sort] ?? -1) - (a[sort] ?? -1))) : []
  return <>
    <PageHead no={24} title="Academic performance" sub="Assessment results, completion and engagement — filter by faculty, programme, course, semester and date range." />
    <ScopeBar prefix="pf" meta={meta.data} value={scope} onChange={s => { setScope(s); setCourse('all') }}>
      <Sel id="pf-course" label="Course" value={course} onChange={setCourse} options={[['all', 'All'], ...courses.map(c => [c.id, c.code] as [string, string])]} />
      <Sel id="pf-range" label="Date range" value={range} onChange={setRange} options={[['sem', 'Semester to date'], ['30', 'Last 30 days']]} />
    </ScopeBar>
    {q.isLoading ? <Loading label="Calculating…" /> : q.error ? <ErrorBox error={q.error} retry={() => q.refetch()} /> : !d || !k ? null : !k.learners ? <Empty icon="chart" title="No courses in this scope">Choose another faculty, programme or course.</Empty> : <div className="stack" style={{ opacity: q.isFetching ? .6 : 1, marginTop: 16 }}>
      <div className="g g4">
        <Kpi label="Mean mark" value={n0(k.mark, '%')} delta={`${k.graded_n} graded · mean ${n0(k.graded_mean, '%')}`} tip={D.mark} />
        <Kpi label="Pass rate" value={n0(k.pass, '%')} delta="marks ≥ 40%" tip={D.pass} />
        <Kpi label="Completion" value={n0(k.completion, '%')} delta="activities completed" tip={D.completion} />
        <Kpi label="Weekly active" value={n0(k.active_pct, '%')} delta={`${k.learners} learners in scope`} tip={D.active} />
      </div>
      <div className="g g2">
        <Card title="Average mark by course">{rows.length ? <GroupBars labels={rows.slice(0, 10).map(c => c.code.replace('HB-', ''))} series={[{ name: 'Avg mark %', color: 'var(--c1)', data: rows.slice(0, 10).map(c => c.mark) }, { name: 'Pass rate %', color: 'var(--c2)', data: rows.slice(0, 10).map(c => c.pass) }]} /> : <Empty title="No marks yet" />}</Card>
        <Card title={<>Score distribution <Tip text="Per-enrolment marks grouped into 10-point bands (inclusive ranges)." /></>} actions={<span className="xs muted">{d.distribution.reduce((a, b) => a + b.value, 0)} enrolments</span>}>
          <VBars data={d.distribution.map(b => ({ label: b.label, value: b.value }))} color="var(--c1)" />
          <p className="xs muted">Bands are percentage ranges (e.g. 40–49 means 40% up to but not including 50%).</p></Card>
      </div>
      <div className="g g2">
        <Card title="Completion by course"><HBars suffix="%" max={100} rows={rows.map(c => ({ label: `${c.code} ${c.title}`, value: c.completion || 0, kind: (c.completion ?? 100) < 50 ? 'warn' : 'c2' }))} /></Card>
        <Card title="Engagement by faculty"><HBars suffix="%" max={100} rows={d.faculties.map(f => ({ label: f.short, value: f.active || 0 }))} /></Card>
      </div>
      <Card title="Performance trend" actions={<span className="xs muted">{d.term}{range === '30' ? ' · last 30 days' : ''}</span>}>
        {d.trend.length ? <div className="g g2">
          <div><div className="eyebrow">Weekly active learners %</div><LineChart labels={weekLabels(d.trend)} max={100}
            series={[{ name: 'Weekly active %', color: 'var(--c2)', data: d.trend.map(t => k.learners ? Math.round(t.active * 100 / k.learners) : 0) }]} /></div>
          <div><div className="eyebrow">Submissions per week</div><VBars color="var(--c1)" height={180}
            data={d.trend.map((t, i) => ({ label: weekLabels(d.trend)[i], value: t.submissions }))} /></div>
        </div> : <Empty title="No activity in this period" />}
        <p className="xs muted">Mean mark of graded work by week: {d.trend.filter(t => t.graded_mean != null).map(t => `${fmtDate(t.start)} ${Math.round(t.graded_mean!)}%`).join(' · ') || 'none graded in this period'}. Weeks start on Monday; * = week to date (incomplete).</p>
      </Card>
      <Card title="Course comparison" actions={<Sel id="pf-sort" label="Sort" value={sort} onChange={v => setSort(v as any)} options={[['mark', 'Mean mark'], ['completion', 'Completion'], ['pass', 'Pass rate'], ['learners', 'Learners']]} />}>
        <div className="tbl-wrap"><table className="t"><thead><tr><th>Course</th><th className="adm-hide-sm">Faculty</th><th className="n">Learners</th><th className="n">Mean mark</th><th className="n">Pass rate</th><th className="n">Completion</th><th className="n">Active</th><th className="n">Overdue</th><th></th></tr></thead>
          <tbody>{rows.map(c => <tr key={c.id}><td><b>{c.code}</b> <span className="small">{c.title}</span></td><td className="small adm-hide-sm">{c.faculty}</td><td className="n">{c.learners}</td>
            <td className="n">{n1(c.mark, '%')}</td><td className="n">{n0(c.pass, '%')}</td><td className="n">{(c.completion ?? 100) < 50 ? <Badge kind="warn">{n0(c.completion, '%')}</Badge> : n0(c.completion, '%')}</td><td className="n">{n0(c.active, '%')}</td><td className="n">{c.overdue || '—'}</td>
            <td><button className="btn sm" onClick={() => setDrill(c.id)}>Drill down</button></td></tr>)}</tbody></table></div>
      </Card>
    </div>}
    {drill && <Drill id={drill} onClose={() => setDrill(null)} />}
  </>
}

const weekLabels = (t: { start: string }[]) => t.map((w, i) => fmtDate(w.start) + (i === t.length - 1 ? '*' : ''))

function Drill({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ['admin-perf-course', id], queryFn: () => get<any>(`/api/admin/performance/course/${id}`) })
  return <Modal wide title={q.data ? `${q.data.course.code} · ${q.data.course.title}` : 'Course detail'} onClose={onClose} footer={<button className="btn" onClick={onClose}>Close</button>}>
    {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} retry={() => q.refetch()} /> : <>
      <p className="small muted">{q.data.course.lecturer || 'No lecturer assigned'} · {q.data.course.term}. Aggregate figures only — open individual records from the Student directory.</p>
      <div className="eyebrow" style={{ marginTop: 10 }}>Assessments</div>
      {q.data.assessments.length ? <div className="tbl-wrap"><table className="t"><thead><tr><th>Assessment</th><th>Due</th><th className="n">Submitted</th><th className="n">Graded</th><th className="n">Mean</th><th className="n">Pass rate</th><th className="n">Late</th></tr></thead>
        <tbody>{q.data.assessments.map((a: any) => <tr key={a.id}><td>{a.title} <span className="xs muted">{a.type} · {a.weight}%</span></td><td className="small">{fmtDate(a.due)}</td>
          <td className="n">{a.submitted}/{a.enrolled}</td><td className="n">{a.graded}</td><td className="n">{n1(a.mean, '%')}</td><td className="n">{n0(a.pass, '%')}</td><td className="n">{a.late || '—'}</td></tr>)}</tbody></table></div> : <Empty title="No assessments yet" />}
      <div className="eyebrow" style={{ marginTop: 14 }}>Learner progress bands</div>
      <VBars data={q.data.progress_bands} color="var(--c2)" height={140} />
    </>}
  </Modal>
}
