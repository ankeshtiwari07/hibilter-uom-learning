import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Icon } from '../../components/Icon'
import { Badge, Empty, ErrorBox, Loading, Note, PageHead, Seg, useToast } from '../../components/ui'
import { api, download, get, put } from '../../lib/api'
import { fmtDate } from '../../lib/format'
import { DueBadge, StatusBadge, dueLabel, errText, rid } from './shared'

type Row = { id: string; title: string; course_code: string; course_id: string; due?: string; weight: number; max: number; status: string; can_submit: boolean
  closed: boolean; late_window: boolean; score?: number | null; submitted_at?: string | null }
type Detail = Row & {
  instructions: string; rubric: any[]; settings: { allowed: string[]; max_mb: number; allow_late: boolean }; opened?: string; lecturer?: string
  submission: null | { status: string; text?: string | null; draft?: string | null; file_name?: string | null; has_file: boolean; submitted_at?: string | null; late: boolean; receipt?: string | null; words?: number | null }
  history: { at: string; file?: string | null; receipt: string; late: boolean; text?: boolean }[]
  feedback: null | { score?: number | null; max: number; text?: string | null; by: string; status: string }
}
const MAXB = 20 * 1024 * 1024

export default function Assignments() {
  const [sp, setSp] = useSearchParams()
  const q = useQuery({ queryKey: ['s-assign'], queryFn: () => get<Row[]>('/api/student/assignments') })
  const [filter, setFilter] = useState('all')
  const rows = useMemo(() => (q.data || []).filter(r => filter === 'all' || (filter === 'todo' ? ['not_submitted', 'draft', 'overdue'].includes(r.status) : filter === 'sub' ? ['submitted', 'late'].includes(r.status) : r.status === 'graded')), [q.data, filter])
  const sel = sp.get('id') || rows[0]?.id || q.data?.[0]?.id
  return <>
    <PageHead no={7} title="Assignments" sub="Instructions, submission and feedback for your coursework." />
    {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} retry={() => q.refetch()} /> : !q.data!.length ? <Empty icon="clip" title="No assignments yet">Assignments from your enrolled courses will appear here.</Empty> : <>
      <Seg options={[['all', 'All'], ['todo', 'To do'], ['sub', 'Submitted'], ['graded', 'Marked']]} value={filter} onChange={setFilter} />
      <div className="g g-12">
        <div className="card pad0">{rows.length ? <div className="tbl-wrap" style={{ border: 0 }}><table className="t"><thead><tr><th>Assignment</th><th>Due</th><th>Status</th></tr></thead>
          <tbody>{rows.map(a => <tr key={a.id} className={a.id === sel ? 'sel' : ''} style={{ cursor: 'pointer' }} tabIndex={0} onClick={() => setSp({ id: a.id })} onKeyDown={e => e.key === 'Enter' && setSp({ id: a.id })}>
            <td><b>{a.title}</b><div className="xs muted">{a.course_code} · {a.weight}%</div></td><td className="small">{a.due ? fmtDate(a.due) : '—'}<div className="xs muted">{a.status === 'graded' || a.status === 'submitted' ? '' : dueLabel(a.due)}</div></td>
            <td>{a.status === 'graded' && a.score != null ? <Badge kind="good">Marked · {a.score}/{a.max}</Badge> : <StatusBadge s={a.status} />}</td></tr>)}</tbody></table></div>
          : <Empty icon="filter" title="Nothing in this view" />}</div>
        {sel ? <AssignmentDetail key={sel} id={sel} /> : <div />}
      </div></>}
  </>
}

function Rubric({ rubric }: { rubric: any[] }) {
  if (!rubric?.length) return null
  return <div style={{ marginTop: 12 }}><div className="eyebrow">Marking rubric</div><div className="tbl-wrap" style={{ marginTop: 6 }}><table className="t"><thead><tr><th>Criterion</th><th className="n">Weight</th></tr></thead>
    <tbody>{rubric.map((r, i) => <tr key={i}><td>{typeof r === 'string' ? r : r.criterion || r.name || r.c || r.title}<div className="xs muted">{r.desc || r.d || r.description || ''}</div></td>
      <td className="n">{r.weight ?? r.w ?? r.points ?? r.marks ?? ''}{r.weight != null || r.w != null ? '%' : ''}</td></tr>)}</tbody></table></div></div>
}

function AssignmentDetail({ id }: { id: string }) {
  const qc = useQueryClient(); const toast = useToast()
  const q = useQuery({ queryKey: ['s-assign', id], queryFn: () => get<Detail>(`/api/student/assignments/${id}`) })
  const [file, setFile] = useState<File | null>(null)
  const [text, setText] = useState('')
  const [decl, setDecl] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [over, setOver] = useState(false)
  const [replacing, setReplacing] = useState(false)
  const idem = useRef(rid())
  const inp = useRef<HTMLInputElement>(null)
  useEffect(() => { if (q.data?.submission) setText(q.data.submission.draft || q.data.submission.text || '') }, [q.data?.submission?.draft, q.data?.submission?.text])
  const refresh = () => { qc.invalidateQueries({ queryKey: ['s-assign'] }); qc.invalidateQueries({ queryKey: ['s-dash'] }) }
  const draft = useMutation({ mutationFn: () => put(`/api/student/assignments/${id}/draft`, { text }), onSuccess: () => { toast('Draft saved'); refresh() }, onError: (e: any) => toast(errText(e), true) })
  const submit = useMutation({
    mutationFn: () => { const fd = new FormData(); fd.append('declaration', 'true'); fd.append('text', text); fd.append('idem', idem.current); if (file) fd.append('file', file)
      return api<{ receipt: string; late: boolean }>(`/api/student/assignments/${id}/submit`, { method: 'POST', body: fd }) },
    onSuccess: r => { toast(`Submission received · receipt ${r.receipt}${r.late ? ' · marked late' : ''}`); setFile(null); setDecl(false); setReplacing(false); idem.current = rid(); refresh() },
    onError: (e: any) => { setErr(errText(e)); toast(errText(e), true) },
  })
  if (q.isLoading) return <div className="card"><Loading /></div>
  if (q.error) return <div className="card"><ErrorBox error={q.error} retry={() => q.refetch()} /></div>
  const a = q.data!, s = a.submission
  const exts = a.settings.allowed
  const pick = (f?: File | null) => {
    setErr(null); if (!f) { setFile(null); return }
    const ext = '.' + (f.name.split('.').pop() || '').toLowerCase()
    if (!exts.includes(ext)) { setErr(`That file type isn’t accepted. Upload ${exts.map(x => x.slice(1).toUpperCase()).join(', ')}.`); return }
    if (f.size > MAXB) { setErr('That file is larger than 20 MB.'); return }
    if (f.size === 0) { setErr('That file is empty.'); return }
    setFile(f)
  }
  const doSubmit = () => {
    const m = !file && !text.trim() && !s?.file_name ? 'Choose a file to submit, or write your answer in the text box.' : !decl ? 'Tick the declaration to confirm the work is your own.' : ''
    setErr(m || null); if (!m) submit.mutate()
  }
  const submitted = s && ['submitted', 'graded', 'published'].includes(s.status)
  const showForm = a.can_submit && (!submitted || replacing)
  return <div className="card">
    <div className="hd"><h3>{a.title}</h3><Badge kind="out">{a.course_code}</Badge></div>
    <dl className="kv"><dt>Due</dt><dd>{a.due ? <>{fmtDate(a.due, true)} <DueBadge due={a.due} /></> : 'No deadline'}</dd><dt>Weight</dt><dd>{a.weight}% · {a.max} marks</dd>
      <dt>Submission</dt><dd>{exts.map(x => x.slice(1).toUpperCase()).join(', ')} · max {a.settings.max_mb} MB{a.settings.allow_late ? ' · late submissions are flagged' : ''}</dd>{a.lecturer && <><dt>Lecturer</dt><dd>{a.lecturer}</dd></>}</dl>
    <div style={{ marginTop: 12 }}><div className="eyebrow">Instructions</div><p className="small" style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>{a.instructions || 'Your lecturer hasn’t added written instructions. Check the course announcements.'}</p></div>
    <Rubric rubric={a.rubric} />

    {a.feedback && <div className="card flat" style={{ marginTop: 14 }}><div className="row sb"><b>Lecturer feedback</b><Badge kind="good">{a.feedback.score ?? '—'} / {a.feedback.max}</Badge></div>
      <p className="small" style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>{a.feedback.text || 'No written feedback was added.'}{a.feedback.text ? ` — ${a.feedback.by}` : ''}</p>
      <div className="xs muted" style={{ marginTop: 6 }}>Marked by a lecturer, not by AI</div></div>}

    {submitted && !replacing && <><Note kind="teal" icon="checkc"><b>Submitted {fmtDate(s!.submitted_at, true)}{s!.late ? ' (late)' : ''}</b><br />
      {s!.file_name ? <button className="link-btn" onClick={() => download(`/api/student/assignments/${id}/file`, s!.file_name!).catch(e => toast(errText(e), true))}>{s!.file_name}</button> : 'Text answer'}
      {s!.receipt && <> · receipt <span className="mono">{s!.receipt}</span></>}{a.can_submit && !a.closed ? '. You can replace it until the deadline.' : '.'}</Note>
      {a.can_submit && !a.closed && <button className="btn sm" style={{ marginTop: 8 }} onClick={() => setReplacing(true)}><Icon n="upload" />Replace submission</button>}</>}

    {showForm && <div style={{ marginTop: 14 }}>
      {a.late_window && <Note kind="warn" icon="alert">The deadline has passed. You can still submit once; it will be recorded as late.</Note>}
      <label className={`drop ${over ? 'over' : ''}`} htmlFor="as-file" onDragOver={e => { e.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)}
        onDrop={e => { e.preventDefault(); setOver(false); pick(e.dataTransfer.files[0]) }}>
        <Icon n="upload" /><b>Drop your file here or browse</b><span className="xs">{exts.map(x => x.slice(1).toUpperCase()).join(', ')} · max 20 MB</span></label>
      <input ref={inp} type="file" id="as-file" className="sr" accept={exts.join(',')} onChange={e => pick(e.target.files?.[0])} />
      {file && <div className="row small" style={{ marginTop: 8 }}><Icon n="file" /><b>{file.name}</b><span className="muted">{(file.size / 1024).toFixed(0)} KB</span><button className="iconbtn" aria-label="Remove file" onClick={() => { setFile(null); if (inp.current) inp.current.value = '' }}><Icon n="x" /></button></div>}
      {!file && s?.file_name && <p className="xs muted" style={{ marginTop: 6 }}>Current file: {s.file_name} (kept unless you choose a new one)</p>}
      <div className="field" style={{ marginTop: 10 }}><label htmlFor="as-text">Written answer or note to the marker (optional)</label>
        <textarea id="as-text" className="inp" rows={4} maxLength={60000} value={text} onChange={e => setText(e.target.value)} />
        <span className="hint">{text.trim() ? text.trim().split(/\s+/).length : 0} words · drafts are saved to your account, not submitted</span></div>
      <label className="chk" style={{ marginTop: 10 }}><input type="checkbox" checked={decl} onChange={e => setDecl(e.target.checked)} />I confirm this is my own work and I have acknowledged any AI assistance used.</label>
      {err && <span className="err small" role="alert" style={{ color: 'var(--bad)', display: 'block', marginTop: 6 }}><Icon n="alert" /> {err}</span>}
      <div className="row" style={{ marginTop: 10 }}><button className="btn pri" disabled={submit.isPending} onClick={doSubmit}><Icon n="upload" />{submit.isPending ? 'Uploading…' : submitted ? 'Submit replacement' : 'Submit assignment'}</button>
        <button className="btn" disabled={draft.isPending || submit.isPending} onClick={() => draft.mutate()}><Icon n="save" />Save draft</button>
        {replacing && <button className="btn ghost" onClick={() => setReplacing(false)}>Cancel</button>}</div>
    </div>}
    {!a.can_submit && !submitted && <Note kind="bad" icon="lock">Submission is closed for this assignment.</Note>}

    <div style={{ marginTop: 16 }}><div className="eyebrow">Submission history</div><div className="tl" style={{ marginTop: 8 }}>
      {a.history.map((h, i) => <div className="it" key={i}><b className="small">Submitted {h.file || 'text answer'}{h.late ? ' (late)' : ''}</b><div className="xs muted">{fmtDate(h.at, true)} · <span className="mono">{h.receipt}</span></div></div>)}
      <div className="it n"><b className="small">Assignment opened</b><div className="xs muted">{fmtDate(a.opened)}</div></div></div></div>
  </div>
}
