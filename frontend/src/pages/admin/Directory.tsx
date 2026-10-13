import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Icon } from '../../components/Icon'
import { Avatar, Badge, Bar, Empty, ErrorBox, Field, Kpi, Loading, Modal, Note, PageHead, useToast } from '../../components/ui'
import { download, get, post } from '../../lib/api'
import { fmtDate, rel } from '../../lib/format'
import { FOLLOW_KIND, InlineErr, n0, Pager, qs, Sel, useDebounced, useMeta } from './shared'

type Row = { id: string; name: string; student_no: string; email: string; programme: string | null; year: number | null; status: string; courses: number; activity: number | null; avg: number | null; last_seen: string | null; last_active_hint: string | null; overdue: number }
type Page = { items: Row[]; total: number; page: number; size: number; all: number; reasons: string[] }

export default function Directory() {
  const meta = useMeta(); const toast = useToast()
  const [q, setQ] = useState(''); const dq = useDebounced(q)
  const [f, setF] = useState({ programme: 'all', course: 'all', activity: 'all', sort: 'name' })
  const [page, setPage] = useState(1)
  const params = { q: dq, ...f, page, size: 25 }
  const list = useQuery({ queryKey: ['admin-students', params], queryFn: () => get<Page>('/api/admin/students' + qs(params)), placeholderData: p => p })
  const [open, setOpen] = useState<Row | null>(null)
  const [exporting, setExporting] = useState(false)
  const set = (k: string, v: string) => { setF({ ...f, [k]: v }); setPage(1) }
  const exportCsv = async () => {
    setExporting(true)
    try { await download('/api/admin/students.csv' + qs({ q: dq, programme: f.programme, course: f.course, activity: f.activity }), 'student-directory.csv'); toast('Export downloaded — recorded in the audit log') }
    catch (e: any) { toast(e.message, true) } finally { setExporting(false) }
  }
  return <>
    <PageHead no={23} title="Student directory" sub="Search learners and open records you have a role-approved reason to view. All identities are fictional."
      actions={<button className="btn" disabled={exporting} onClick={exportCsv}><Icon n="download" />{exporting ? 'Exporting…' : 'Export list'}</button>} />
    <div className="card" style={{ padding: '12px 14px' }}><div className="filters">
      <div className="field" style={{ flex: '1 1 220px' }}><label htmlFor="dr-q">Search</label><input className="inp" id="dr-q" type="search" placeholder="Name, student ID or email" value={q} maxLength={100} onChange={e => { setQ(e.target.value); setPage(1) }} /></div>
      <Sel id="dr-prog" label="Programme" value={f.programme} onChange={v => set('programme', v)} options={[['all', 'All'], ...(meta.data?.programmes || []).map(p => [p.id, p.name.replace(/^(BSc|BEng|BA|MSc) \(Hons\) /, '')] as [string, string])]} />
      <Sel id="dr-course" label="Course" value={f.course} onChange={v => set('course', v)} options={[['all', 'All'], ...(meta.data?.courses || []).filter(c => c.status !== 'archived').map(c => [c.id, c.code] as [string, string])]} />
      <Sel id="dr-st" label="Activity" value={f.activity} onChange={v => set('activity', v)} options={[['all', 'All'], ['low', 'Low activity (<35)'], ['over', 'Has overdue work'], ['suspended', 'Suspended accounts']]} />
      <Sel id="dr-sort" label="Sort by" value={f.sort} onChange={v => set('sort', v)} options={[['name', 'Name'], ['activity', 'Activity (low first)'], ['avg', 'Average (low first)'], ['last', 'Last active'], ['year', 'Year']]} />
    </div></div>
    <div style={{ marginTop: 16 }}>
      {list.isLoading ? <Loading label="Searching…" /> : list.error ? <ErrorBox error={list.error} retry={() => list.refetch()} /> : <>
        <div className="tbl-wrap" style={{ opacity: list.isFetching ? .6 : 1 }}><table className="t"><thead><tr><th>Student</th><th className="adm-hide-sm">Programme</th><th className="n adm-hide-sm">Year</th><th className="n adm-hide-sm">Courses</th><th className="adm-hide-sm">Activity</th><th className="n">Avg</th><th className="adm-hide-sm">Last active</th><th></th></tr></thead>
          <tbody>{list.data!.items.map(s => <tr key={s.id}>
            <td><div className="who"><Avatar name={s.name} kind="t" /><div><div className="nm"><button className="link-btn" style={{ color: 'inherit', fontWeight: 600, textAlign: 'left' }} onClick={() => setOpen(s)}>{s.name}</button> {s.status !== 'active' && <Badge kind="bad">Suspended</Badge>}</div><div className="sub mono">{s.student_no}</div></div></div></td>
            <td className="small adm-hide-sm">{s.programme || '—'}</td><td className="n adm-hide-sm">{s.year ?? '—'}</td><td className="n adm-hide-sm">{s.courses}</td>
            <td className="adm-hide-sm" style={{ minWidth: 120 }}><div className="row" style={{ flexWrap: 'nowrap' }}><Bar v={s.activity || 0} kind={(s.activity ?? 100) < 35 ? 'warn' : ''} /><span className="num xs">{n0(s.activity)}</span></div></td>
            <td className="n">{n0(s.avg, '%')}</td>
            <td className="small adm-hide-sm">{s.last_seen ? rel(s.last_seen) : s.last_active_hint || '—'}{s.overdue > 0 && <div><Badge kind="warn">{s.overdue} overdue</Badge></div>}</td>
            <td><button className="btn sm" onClick={() => setOpen(s)}><Icon n="lock" />Open record</button></td></tr>)}
            {!list.data!.items.length && <tr><td colSpan={8}><Empty icon="users" title="No students match">Try a different search or clear the filters.</Empty></td></tr>}
          </tbody></table></div>
        <Pager page={page} size={25} total={list.data!.total} onPage={setPage} label={`matching students · ${list.data!.all} demo students in total`} />
      </>}
    </div>
    {open && <RecordFlow row={open} reasons={list.data?.reasons || []} onClose={() => setOpen(null)} />}
  </>
}

function RecordFlow({ row, reasons, onClose }: { row: Row; reasons: string[]; onClose: () => void }) {
  const [reason, setReason] = useState(''); const [detail, setDetail] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const m = useMutation({ mutationFn: () => post<any>(`/api/admin/students/${row.id}/record`, { reason, detail: detail.trim() || null }), onError: (e: any) => setErr(e.status === 403 ? 'Access denied — your role does not allow opening individual records.' : e.message) })
  const go = () => {
    if (!reason) return setErr('Choose a reason to continue.')
    if (reason === 'Other' && detail.trim().length < 10) return setErr('Describe the reason for access (at least 10 characters).')
    setErr(null); m.mutate()
  }
  if (m.data) return <RecordView r={m.data} onClose={onClose} />
  return <Modal title="Open student record" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn pri" disabled={m.isPending} onClick={go}>{m.isPending ? 'Opening…' : 'Open record'}</button></>}>
    <Note icon="shield">Individual records are role-controlled. Opening one is written to the audit log with your name, the time and your reason.</Note>
    <div className="col" style={{ marginTop: 12 }}>
      <div className="small"><b>{row.name}</b> <span className="mono xs muted">{row.student_no}</span></div>
      <Field label="Reason for access" htmlFor="rr" error={err && !reason ? err : null}>
        <select className={`inp ${err && !reason ? 'bad' : ''}`} id="rr" value={reason} onChange={e => setReason(e.target.value)}><option value="">Choose…</option>{reasons.map(r => <option key={r}>{r}</option>)}<option value="Other">Other (describe)</option></select>
      </Field>
      <Field label={reason === 'Other' ? 'Describe the reason' : 'Details (optional)'} htmlFor="rr-d" hint="Stored with the audit entry. Don't include sensitive personal information.">
        <textarea className="inp" id="rr-d" rows={2} maxLength={500} value={detail} onChange={e => setDetail(e.target.value)} /></Field>
      {reason && <InlineErr msg={err} />}
    </div>
  </Modal>
}

const OUTCOME: Record<string, string> = { passed: 'good', assisted: 'teal', skipped: 'out', failed: 'bad' }

function RecordView({ r, onClose }: { r: any; onClose: () => void }) {
  const p = r.profile, v = r.vf
  return <Modal wide title={p.name} onClose={onClose} footer={<button className="btn" onClick={onClose}>Close record</button>}>
    <div className="row"><Avatar name={p.name} kind="t" size={48} /><div><b>{p.name}</b> {p.status !== 'active' && <Badge kind="bad">Suspended</Badge>}<div className="xs muted mono">{p.student_no} · {p.email}</div></div></div>
    <dl className="kv" style={{ marginTop: 10 }}><dt>Programme</dt><dd>{p.programme || '—'}{p.year ? `, Year ${p.year}` : ''}</dd>
      <dt>Activity score</dt><dd>{r.indicators.activity ?? '—'}/100 · last active {p.last_seen ? rel(p.last_seen) : p.last_active_hint || '—'}</dd>
      <dt>Average mark</dt><dd>{r.grade_mean != null ? `${r.grade_mean}% (graded work)` : r.indicators.avg != null ? `${r.indicators.avg}% (recorded)` : '—'}</dd>
      <dt>Completion</dt><dd>{r.indicators.completion ?? '—'}%</dd><dt>Overdue</dt><dd>{r.indicators.overdue ?? 0}</dd></dl>
    {r.signals.length > 0 && <div style={{ marginTop: 10 }}><div className="eyebrow">Support indicators (for human review)</div><div className="row" style={{ marginTop: 4 }}>{r.signals.map((s: any) => <span key={s.k} className={`b ${s.k === 'vf' ? 'teal' : 'warn'}`} title={s.rule}>{s.t}</span>)}
      {r.followup && <Badge kind={FOLLOW_KIND[r.followup.status] || 'out'}>Follow-up: {r.followup.status}{r.followup.owner_name ? ` · ${r.followup.owner_name}` : ''}</Badge>}</div></div>}
    <div className="eyebrow" style={{ marginTop: 14 }}>Enrolments & progress</div>
    {r.enrolments.length ? <div className="tbl-wrap"><table className="t"><thead><tr><th>Course</th><th>Lecturer</th><th>Progress</th><th>Status</th></tr></thead><tbody>
      {r.enrolments.map((e: any) => <tr key={e.course_id}><td><b>{e.code}</b> <span className="small">{e.title}</span><div className="xs muted">{e.term}</div></td><td className="small">{e.lecturer || '—'}</td>
        <td style={{ minWidth: 120 }}><div className="row" style={{ flexWrap: 'nowrap' }}><Bar v={e.progress || 0} /><span className="num xs">{n0(e.progress, '%')}</span></div>{!e.progress_tracked && <span className="xs muted">recorded indicator</span>}</td>
        <td><Badge kind={e.status === 'active' ? 'good' : 'out'}>{e.status}</Badge></td></tr>)}</tbody></table></div> : <p className="small muted">No enrolments.</p>}
    <div className="eyebrow" style={{ marginTop: 14 }}>Assessment history</div>
    {r.grades.length ? <div className="tbl-wrap"><table className="t"><thead><tr><th>Assessment</th><th>Due</th><th>Status</th><th className="n">Mark</th></tr></thead><tbody>
      {r.grades.map((g: any, i: number) => <tr key={i}><td><span className="xs muted">{g.code}</span> {g.title}</td><td className="small">{fmtDate(g.due)}</td>
        <td><Badge kind={g.status === 'missing' ? 'bad' : ['graded', 'published'].includes(g.status) ? 'good' : g.status === 'submitted' ? 'info' : 'out'}>{g.status}</Badge>{g.late && <> <Badge kind="warn">late</Badge></>}</td>
        <td className="n">{g.score != null ? `${g.score}/${g.max} (${g.pct}%)` : '—'}</td></tr>)}</tbody></table></div> : <p className="small muted">No published assessments in the learner's courses.</p>}
    <div className="eyebrow" style={{ marginTop: 14 }}>Virtual faculty checkpoints</div>
    <div className="g g4" style={{ marginTop: 6 }}>
      <Kpi label="Sessions" value={v.sessions} delta={`${v.completed} completed`} />
      <Kpi label="First-try correct" value={n0(v.first_try, '%')} />
      <Kpi label="Hints used" value={v.hints} />
      <Kpi label="Assisted checkpoints" value={v.assisted} delta="reviewed by lecturer" />
    </div>
    {Object.keys(v.outcomes).length > 0 && <div className="row" style={{ marginTop: 8 }}>{Object.entries(v.outcomes).map(([k, n]) => <Badge key={k} kind={OUTCOME[k] || 'out'}>{k}: {String(n)}</Badge>)}</div>}
    {v.recent.length > 0 && <div className="list" style={{ marginTop: 6 }}>{v.recent.slice(0, 5).map((s: any, i: number) => <div className="li" key={i}><div className="ic teal"><Icon n="cap" /></div><div className="bd"><div className="tt small">{s.lesson}</div><div className="ds">{s.code} · {fmtDate(s.at, true)} · {s.attempts} answers · {Object.entries(s.outcome).map(([cp, o]) => `${cp} ${o}`).join(', ') || 'no checkpoints yet'}</div></div><Badge kind={s.status === 'completed' ? 'good' : 'out'}>{s.status}</Badge></div>)}</div>}
    {v.reviews.length > 0 && <p className="xs muted" style={{ marginTop: 6 }}>{v.reviews.filter((x: any) => x.status === 'open').length} checkpoint review(s) open with the course lecturer.</p>}
    <Note icon="shield"><span className="xs">Access logged: {r.access.reason} — {r.access.by}, {fmtDate(r.access.at, true)}.</span></Note>
  </Modal>
}
