import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Icon } from '../../components/Icon'
import { Badge, Card, Empty, ErrorBox, HBars, Kpi, LineChart, Loading, Note, PageHead, VBars, useToast } from '../../components/ui'
import { download, get } from '../../lib/api'
import { rel } from '../../lib/format'
import { Sel, useMyCourses } from './shared'

const RANGES: [string, string][] = [['', 'All time'], ['6', 'Last 6 weeks'], ['4', 'Last 4 weeks'], ['2', 'Last 2 weeks']]
const OUT: Record<string, string> = { passed: 'good', assisted: 'warn', skipped: 'out' }

export default function VFAnalytics() {
  const toast = useToast()
  const [f, setF] = useState({ course: '', lesson: '', avatar: '', range: '' })
  const courses = useMyCourses()
  const lessons = useQuery({ queryKey: ['vf-lect-lessons'], queryFn: () => get<any[]>('/api/lecturer/vf/lessons') })
  const avatars = useQuery({ queryKey: ['avatars'], queryFn: () => get<any[]>('/api/vf/avatars') })
  const frm = f.range ? new Date(Date.now() - +f.range * 7 * 864e5).toISOString().slice(0, 10) : ''
  const qs = new URLSearchParams(Object.entries({ course_id: f.course, lesson_id: f.lesson, avatar_id: f.avatar, frm }).filter(([, v]) => v) as [string, string][]).toString()
  const q = useQuery({ queryKey: ['vf-analytics', qs], queryFn: () => get<any>(`/api/lecturer/vf/analytics${qs ? `?${qs}` : ''}`) })
  const [busy, setBusy] = useState(false)
  const csv = async () => { setBusy(true); try { await download(`/api/lecturer/vf/analytics.csv${qs ? `?${qs}` : ''}`, 'virtual-faculty-analytics.csv'); toast('CSV downloaded — export recorded in the audit log') } catch (e: any) { toast(e.message, true) } finally { setBusy(false) } }
  const set = (k: string, v: string) => setF(x => ({ ...x, [k]: v, ...(k === 'course' ? { lesson: '' } : {}) }))
  const s = q.data
  const ls = (lessons.data || []).filter(l => !f.course || l.course_id === f.course)
  return <>
    <PageHead no={37} title="Virtual classroom analytics" sub="How learners engage with digital lecturers, where they struggle, and whether understanding improves."
      actions={<button className="btn" disabled={busy || !s?.started} onClick={csv}><Icon n="download" />{busy ? 'Preparing…' : 'Export CSV'}</button>} />
    <div className="card" style={{ padding: '12px 14px' }}><div className="filters">
      <Sel id="va-course" label="Course" value={f.course} onChange={v => set('course', v)} options={[['', 'All my courses'], ...(courses.data || []).map(c => [c.id, c.code] as [string, string])]} />
      <Sel id="va-lesson" label="Lesson" value={f.lesson} onChange={v => set('lesson', v)} options={[['', 'All lessons'], ...ls.map(l => [l.id, l.title.slice(0, 40)] as [string, string])]} />
      <Sel id="va-avatar" label="Lecturer avatar" value={f.avatar} onChange={v => set('avatar', v)} options={[['', 'All avatars'], ...(avatars.data || []).map(a => [a.id, a.short] as [string, string])]} />
      <Sel id="va-range" label="Date range" value={f.range} onChange={v => set('range', v)} options={RANGES} />
    </div></div>
    {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} retry={() => q.refetch()} /> : !s.started ?
      <Empty icon="chart" title="No virtual classroom sessions match these filters">Try “All lessons” or a wider date range.</Empty> : <>
        <div className="g g4">
          <Kpi label="Sessions started" value={s.started.toLocaleString()} delta={`${s.completed.toLocaleString()} completed · ${Math.round(s.completion)}%`} tip="Sessions where a learner pressed Start in the virtual classroom (restarted sessions counted once)." />
          <Kpi label="Avg session duration" value={s.avg_min != null ? `${s.avg_min} min` : '—'} delta={`Planned lesson length ${s.planned_min} min`} tip="From Start to the recap screen, completed sessions only." />
          <Kpi label="Checkpoint response rate" value={s.response_rate != null ? `${Math.round(s.response_rate)}%` : '—'} delta="Checkpoints answered ÷ reached" tip="Share of checkpoints reached where the learner submitted at least one answer." />
          <Kpi label="First-attempt correct" value={s.first_attempt != null ? `${Math.round(s.first_attempt)}%` : '—'} delta={`${s.avg_attempts ?? '—'} attempts per question`} tip="Share of checkpoint answers judged correct on the first submission, under the lecturer’s pass rule." />
        </div>
        <div className="g g4">
          <Kpi label="Hint usage" value={s.hint_use != null ? `${Math.round(s.hint_use)}%` : '—'} delta="checkpoints with ≥1 hint" tip="Share of answered checkpoints where the learner asked for at least one hint." />
          <Kpi label="Abandonment" value={`${Math.round(s.abandon)}%`} delta={`${s.abandoned} sessions`} tip="Sessions closed without reaching the recap or using Save & exit, or idle for 30+ minutes." />
          <Kpi label="Technical failures" value={s.tech_fail_n} delta={`${s.tech_fail}% of sessions`} tip="AI evaluation errors. Counted separately from wrong answers; the answer is never marked correct when this happens." />
          <Kpi label="Pre → post quiz" value={s.prepost ? `${s.prepost.pre}% → ${s.prepost.post}%` : '—'} delta={s.prepost ? <span className="up">+{s.prepost.post - s.prepost.pre} pts</span> : 'No matched quiz yet'} tip="Average on a matched quiz taken before and after the lesson. The strongest learning signal on this page." />
        </div>
        <div className="g g-21">
          <Card title="Sessions per week"><LineChart labels={s.by_week.map((w: any) => w.w)} series={[{ name: 'Started', color: 'var(--c1)', data: s.by_week.map((w: any) => w.s) }, { name: 'Completed', color: 'var(--c2)', data: s.by_week.map((w: any) => w.c) }]} /><p className="xs muted">Weeks start on Monday; the latest week is still in progress.</p></Card>
          <Card title="Learning before and after">{s.prepost ? <VBars data={[{ label: 'Pre-lesson quiz', value: s.prepost.pre }, { label: 'Post-lesson quiz', value: s.prepost.post }]} color="var(--c2)" />
            : <Empty icon="target" title="No matched pre/post quiz">Attach a short quiz before and after the lesson to measure learning gain.</Empty>}
            <p className="xs muted">Engagement counts alone (speaking time, clicks, response speed) are not treated as proof of learning.</p></Card>
        </div>
        <div className="g g2">
          <Card title="First-attempt correctness by checkpoint">
            <HBars rows={s.by_checkpoint.map((c: any) => ({ label: c.label, value: c.first ?? 0, kind: (c.first ?? 0) < 62 ? 'warn' : undefined }))} suffix="%" max={100} />
            <div className="tbl-wrap" style={{ marginTop: 12 }}><table className="t"><thead><tr><th>Checkpoint</th><th className="n">Answered</th><th className="n">Avg attempts</th><th className="n">Hint use</th><th className="n">Assisted</th></tr></thead>
              <tbody>{s.by_checkpoint.map((c: any) => <tr key={c.id}><td className="small">{c.label}{!c.mandatory && <span className="xs muted"> (optional)</span>}</td><td className="n">{c.answered}/{c.reached}</td><td className="n">{c.attempts ?? '—'}</td><td className="n">{c.hint ?? '—'}%</td><td className="n">{c.assisted}</td></tr>)}</tbody></table></div>
          </Card>
          <Card title="Common misconceptions" actions={<span className="xs muted">answers showing each pattern</span>}>
            {s.mis.length ? <HBars rows={s.mis.map((m: any) => ({ label: m.label, value: m.n, kind: 'c5' }))} /> : <Empty title="No misconceptions detected" />}
            {(() => { const worst = [...s.by_checkpoint].filter((c: any) => c.first != null).sort((a: any, b: any) => a.first - b.first)[0]; return worst && worst.first < 62 ?
              <Note kind="teal" icon="bulb"><b>Topic needing more teaching:</b> {worst.label} ({worst.first}% first-try correct). Consider adding the re-teach analogy to the main explanation in the <Link className="link" to="/l-editor">Lesson editor</Link>.</Note> : null })()}
          </Card>
        </div>
        <div className="g g2">
          <Card title="By lecturer avatar">
            <div className="tbl-wrap"><table className="t"><thead><tr><th>Avatar</th><th className="n">Sessions</th><th className="n">Completed</th><th className="n">1st-try correct</th></tr></thead>
              <tbody>{s.by_avatar.map((a: any) => <tr key={a.id}><td>{a.name}</td><td className="n">{a.s}</td><td className="n">{a.c}</td><td className="n">{a.first ?? '—'}%</td></tr>)}</tbody></table></div>
            <p className="xs muted" style={{ marginTop: 8 }}>Differences between avatars are not statistically tested.</p>
          </Card>
          <Card title="Most recent sessions" actions={<Badge kind="teal">{s.recent.length} latest</Badge>}>
            <div className="tbl-wrap"><table className="t"><thead><tr><th>Learner</th><th>Lecturer</th><th>Status</th><th>Checkpoints</th><th className="n">Min</th></tr></thead>
              <tbody>{s.recent.map((x: any) => <tr key={x.id}><td className="small">{x.name}<div className="xs muted">{rel(x.at)}</div></td><td className="small">{x.avatar}</td>
                <td><Badge kind={x.status === 'completed' ? 'good' : x.status === 'active' ? 'teal' : 'warn'}>{x.status}</Badge></td>
                <td>{Object.entries(x.outcome).map(([id, o]: any) => <span key={id} className={`b ${OUT[o] || 'out'}`} style={{ margin: 2 }}>{id.toUpperCase()} {o}{x.attempts[id] ? ` · ${x.attempts[id]}×` : ''}</span>)}{!Object.keys(x.outcome).length && <span className="faint">—</span>}</td>
                <td className="n">{x.min ?? '—'}</td></tr>)}</tbody></table></div>
          </Card>
        </div>
      </>}
  </>
}
