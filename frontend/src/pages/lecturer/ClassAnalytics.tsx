import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Icon } from '../../components/Icon'
import { Badge, Card, Empty, ErrorBox, HBars, Kpi, LineChart, Loading, Modal, PageHead, VBars, useToast } from '../../components/ui'
import { download, get, post } from '../../lib/api'
import { fmtDate, rel } from '../../lib/format'
import { Sel, useMyCourses } from './shared'

export default function ClassAnalytics() {
  const [sp, setSp] = useSearchParams(); const toast = useToast()
  const courses = useMyCourses()
  const cid = sp.get('course') || courses.data?.[0]?.id
  const q = useQuery({ queryKey: ['lect-analytics', cid], queryFn: () => get<any>(`/api/lecturer/analytics/${cid}`), enabled: !!cid })
  const [asel, setAsel] = useState('')
  const [checkIn, setCheckIn] = useState<any>(null)
  const remind = useMutation({ mutationFn: (x: { aid: string; ids: string[] }) => post<any>(`/api/lecturer/grading/assessments/${x.aid}/remind`, { user_ids: x.ids }),
    onSuccess: r => toast(`Reminder sent to ${r.sent} student${r.sent === 1 ? '' : 's'}`), onError: (e: any) => toast(e.message, true) })
  const [exporting, setExporting] = useState(false)
  if (courses.isLoading) return <Loading />
  if (courses.error) return <ErrorBox error={courses.error} retry={() => courses.refetch()} />
  if (!courses.data?.length) return <><PageHead no={19} title="Class analytics" /><Empty icon="chart" title="No courses assigned" /></>
  const c = courses.data.find(x => x.id === cid)!
  const d = q.data
  const csv = async () => { setExporting(true); try { await download(`/api/lecturer/analytics/${cid}/report.csv`, `${c.code}-course-report.csv`); toast('Course report downloaded') } catch (e: any) { toast(e.message, true) } finally { setExporting(false) } }
  const graded = (d?.assessments || []).filter((a: any) => a.graded > 0)
  const ga = graded.find((a: any) => a.id === asel) || graded[graded.length - 1]
  return <>
    <PageHead no={19} title={`Class analytics · ${c.code}`} sub="Engagement, completion and assessment results for your class."
      actions={<button className="btn" onClick={csv} disabled={exporting || !d}><Icon n="download" />{exporting ? 'Preparing…' : 'Download course report'}</button>} />
    <div className="card" style={{ padding: '12px 14px' }}><div className="filters">
      <Sel id="ca-course" label="Course" value={cid!} onChange={v => setSp({ course: v })} options={courses.data.map(x => [x.id, `${x.code} · ${x.title}`])} />
      <span className="sp" />{d && <span className="xs muted">{d.n} enrolled students</span>}</div></div>
    {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} retry={() => q.refetch()} /> : !d.n ? <Empty icon="users" title="Too little data">No students are enrolled in this course yet.</Empty> : <>
      <div className="g g4">
        <Kpi label="Weekly active" value={d.kpis.weekly_active != null ? `${d.kpis.weekly_active}%` : '—'} up={d.kpis.weekly_active >= d.kpis.weekly_active_prev}
          delta={d.kpis.weekly_active_prev != null ? `${d.kpis.weekly_active >= d.kpis.weekly_active_prev ? '▲' : '▼'} ${Math.abs(d.kpis.weekly_active - d.kpis.weekly_active_prev)} pts vs last week (week in progress)` : undefined}
          tip="Students with at least one recorded learning activity this week (lesson, VF session, submission, forum post) ÷ enrolled." />
        <Kpi label="Course completion" value={d.kpis.completion != null ? `${d.kpis.completion}%` : '—'} delta="average learner progress" tip="Mean progress through published course content across enrolled students." />
        <Kpi label={d.kpis.quiz ? `${d.kpis.quiz.title.split(':')[0]} average` : 'Quiz average'} value={d.kpis.quiz ? `${d.kpis.quiz.avg_pct}%` : '—'} delta={d.kpis.quiz ? `median ${Math.round(d.kpis.quiz.median_pct)}% · ${d.kpis.quiz.graded} graded` : 'no graded quiz yet'} tip="Mean score of graded quiz attempts, as a percentage." />
        <Kpi label="Missing submissions" value={`${d.kpis.late} late`} delta={`${d.kpis.pending} not yet submitted`} tip="Published assessments due in the last 3 weeks or upcoming, with no submission." />
      </div>
      <div className="g g2">
        <Card title="Engagement and participation"><LineChart labels={d.weeks} max={100} series={[{ name: 'Weekly active %', color: 'var(--c2)', data: d.weekly_active }]} />
          <p className="xs muted">Weeks start on Monday. The current week is still in progress.</p></Card>
        <Card title="Activity per week"><LineChart labels={d.weeks} series={[{ name: 'VF sessions', color: 'var(--c1)', data: d.vf_sessions }, { name: 'Submissions', color: 'var(--c3)', data: d.submissions }, { name: 'Forum posts', color: 'var(--c5)', data: d.forum_posts }]} /></Card>
      </div>
      <div className="g g2">
        <Card title="Grade distribution" actions={graded.length > 1 ? <select className="inp" style={{ width: 'auto' }} aria-label="Assessment" value={ga?.id} onChange={e => setAsel(e.target.value)}>{graded.map((a: any) => <option key={a.id} value={a.id}>{a.title}</option>)}</select> : undefined}>
          {ga ? <><VBars data={ga.dist} /><p className="xs muted">{ga.title} · {ga.graded} graded · average {ga.avg_pct}% (percent of maximum score)</p></> : <Empty icon="chart" title="No graded work yet">The distribution appears once marks are entered.</Empty>}
        </Card>
        <Card title="Completion">
          <div className="eyebrow">Learner progress</div><HBars rows={d.completion_dist.map((x: any) => ({ label: x.label, value: x.value }))} suffix="" />
          {d.vf_lessons.length > 0 && <><div className="eyebrow" style={{ marginTop: 14 }}>Virtual faculty lessons completed</div><HBars rows={d.vf_lessons} suffix="%" max={100} /></>}
        </Card>
      </div>
      <div className="g g2">
        <Card title="Students requiring academic support" actions={<i className="info" tabIndex={0} data-tip="Rules: any overdue submission, activity score under 35, inactive 9+ days, or falling marks with average under 60. For human review only.">i</i>}>
          {!d.at_risk.length ? <Empty icon="checkc" title="No one flagged" /> : <div className="tbl-wrap"><table className="t"><thead><tr><th>Student</th><th>Why flagged</th><th></th></tr></thead>
            <tbody>{d.at_risk.slice(0, 12).map((s: any) => <tr key={s.id}><td className="small">{s.name}<div className="xs muted">active {rel(s.last_active)}</div></td>
              <td>{s.reasons.map((r: string) => <span key={r} className="b warn" style={{ margin: 2 }}>{r}</span>)}</td>
              <td><button className="btn sm" onClick={() => setCheckIn(s)}>Check in</button></td></tr>)}</tbody></table></div>}
          {d.at_risk.length > 12 && <p className="xs muted">{d.at_risk.length - 12} more — <Link className="link" to={`/l-comms?course=${cid}&to=at_risk`}>message the whole group</Link>.</p>}
          <p className="xs muted" style={{ marginTop: 6 }}>Support indicators for human review — not predictions.</p>
        </Card>
        <Card title="Assessment results">
          <div className="tbl-wrap"><table className="t"><thead><tr><th>Assessment</th><th className="n">Submitted</th><th className="n">Graded</th><th className="n">Average</th></tr></thead>
            <tbody>{d.assessments.map((a: any) => <tr key={a.id}><td className="small">{a.title}<div className="xs muted">{a.type} · due {fmtDate(a.due)}</div></td><td className="n">{a.submitted}</td><td className="n">{a.graded}</td><td className="n">{a.avg_pct != null ? `${a.avg_pct}%` : '—'}</td></tr>)}</tbody></table></div>
        </Card>
      </div>
      <Card title="Quiz item analysis">
        {!d.items.length ? <Empty icon="checkc" title="No item-level quiz data yet">Per-question results appear once students submit a quiz with recorded answers.</Empty> :
          d.items.map((it: any) => <div key={it.id} style={{ marginBottom: 12 }}><b className="small">{it.title}</b>
            <div className="tbl-wrap" style={{ marginTop: 6 }}><table className="t"><thead><tr><th>Question</th><th className="n">Answered</th><th className="n">Correct</th><th>Most chosen option</th></tr></thead>
              <tbody>{it.questions.map((x: any, i: number) => { const top = x.choices.indexOf(Math.max(...x.choices)); return <tr key={i}><td className="small" style={{ minWidth: 220 }}>{i + 1}. {x.q}</td><td className="n">{x.n}</td>
                <td className="n"><Badge kind={x.pct == null ? 'out' : x.pct < 50 ? 'bad' : x.pct < 70 ? 'warn' : 'good'}>{x.pct ?? '—'}{x.pct != null ? '%' : ''}</Badge></td>
                <td className="small">{x.choices.some((n: number) => n) ? `${'ABCDEF'[top]}${top === x.answer ? ' (correct)' : ' — distractor'}` : '—'}</td></tr> })}</tbody></table></div></div>)}
      </Card>
      <Card title="Missing submissions">
        {!d.missing.length ? <Empty icon="checkc" title="Nothing missing" /> : <div className="tbl-wrap"><table className="t"><thead><tr><th>Student</th><th>Assessment</th><th>Status</th><th>Last active</th><th></th></tr></thead>
          <tbody>{d.missing.slice(0, 40).map((m: any) => <tr key={m.student_id + m.assessment_id}><td className="small">{m.name}</td><td className="small">{m.assessment}<div className="xs muted">due {fmtDate(m.due)}</div></td>
            <td><Badge kind={m.status === 'late' ? 'bad' : 'out'}>{m.status === 'late' ? 'Late' : 'Not yet submitted'}</Badge></td><td className="small">{rel(m.last_active)}</td>
            <td><button className="btn sm" disabled={remind.isPending} onClick={() => remind.mutate({ aid: m.assessment_id, ids: [m.student_id] })}><Icon n="bell" />Remind</button></td></tr>)}</tbody></table></div>}
        {d.missing.length > 40 && <p className="xs muted">Showing 40 of {d.missing.length}. Use Grading to remind everyone at once.</p>}
      </Card>
    </>}
    {checkIn && <CheckIn s={checkIn} cid={cid!} onClose={() => setCheckIn(null)} />}
  </>
}

function CheckIn({ s, cid, onClose }: { s: any; cid: string; onClose: () => void }) {
  const toast = useToast()
  const [body, setBody] = useState(`Hi {first name}, I noticed ${s.reasons[0]}. Is there anything I can help with? My office hours are Thursday 14:00–16:00.`)
  const m = useMutation({ mutationFn: () => post<any>('/api/lecturer/comms/messages', { course_id: cid, audience: 'individual', user_ids: [s.id], subject: 'Checking in', body }),
    onSuccess: () => { toast(`Check-in message sent to ${s.first}`); onClose() }, onError: (e: any) => toast(e.message, true) })
  return <Modal title={`Check in with ${s.name}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn pri" disabled={m.isPending || body.trim().length < 10} onClick={() => m.mutate()}><Icon n="send" />Send</button></>}>
    <div className="field"><label htmlFor="ci-b">Message</label><textarea className="inp" id="ci-b" rows={5} value={body} maxLength={5000} onChange={e => setBody(e.target.value)} /><span className="hint">{'{first name}'} is replaced with “{s.first}”. Sent as a private message.</span></div>
  </Modal>
}
