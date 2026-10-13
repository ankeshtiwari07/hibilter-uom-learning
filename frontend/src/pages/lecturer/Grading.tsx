import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Icon } from '../../components/Icon'
import { AiTag, Avatar, Badge, Empty, ErrorBox, Field, Loading, Note, PageHead, Seg, useToast } from '../../components/ui'
import { download, get, post, put } from '../../lib/api'
import { fmtDate } from '../../lib/format'
import { InlineErr, STATUS_BADGE } from './shared'

const FILTERS: [string, string][] = [['all', 'All'], ['to_grade', 'To grade'], ['late', 'Late'], ['not_submitted', 'Not submitted'], ['graded', 'Draft grades'], ['published', 'Published']]

export default function Grading() {
  const [sp, setSp] = useSearchParams()
  const qc = useQueryClient(); const toast = useToast()
  const list = useQuery({ queryKey: ['grading-overview'], queryFn: () => get<any[]>('/api/lecturer/grading/assessments') })
  const aid = sp.get('a') || list.data?.find(a => a.to_grade > 0)?.id || list.data?.[0]?.id
  const [f, setF] = useState('to_grade'); const [sel, setSel] = useState<number | null>(null)
  const queue = useQuery({ queryKey: ['grading-queue', aid], queryFn: () => get<any>(`/api/lecturer/grading/assessments/${aid}/submissions`), enabled: !!aid })
  const publishAll = useMutation({ mutationFn: () => post<any>(`/api/lecturer/grading/assessments/${aid}/publish`, {}),
    onSuccess: r => { toast(`Published ${r.published} grade${r.published === 1 ? '' : 's'}${r.skipped ? ` · ${r.skipped} skipped (missing score or feedback)` : ''}`); qc.invalidateQueries({ queryKey: ['grading-queue', aid] }); qc.invalidateQueries({ queryKey: ['grading-overview'] }); qc.invalidateQueries({ queryKey: ['grading-sub'] }) },
    onError: (e: any) => toast(e.message, true) })
  const remind = useMutation({ mutationFn: (ids: string[]) => post<any>(`/api/lecturer/grading/assessments/${aid}/remind`, { user_ids: ids }),
    onSuccess: r => toast(`Reminder sent to ${r.sent} student${r.sent === 1 ? '' : 's'}`), onError: (e: any) => toast(e.message, true) })
  useEffect(() => { setSel(null); setF('to_grade') }, [aid])
  if (list.isLoading) return <Loading />
  if (list.error) return <ErrorBox error={list.error} retry={() => list.refetch()} />
  if (!list.data!.length) return <><PageHead no={18} title="Submissions & grading" /><Empty icon="clip" title="No published assessments">Publish an assessment in the Assessment builder first.</Empty></>
  const a = list.data!.find(x => x.id === aid) || list.data![0]
  const rows = (queue.data?.rows || []).filter((r: any) => f === 'all' || r.status === f || (f === 'to_grade' && ['submitted', 'late'].includes(r.status)) || (f === 'not_submitted' && ['missing', 'pending'].includes(r.status)))
  const missing = (queue.data?.rows || []).filter((r: any) => ['missing', 'pending'].includes(r.status))
  return <>
    <PageHead no={18} title={a.title} sub={`${a.course_code} · due ${fmtDate(a.due, true)} · ${a.max_score} marks · ${a.weight}% of course`}
      actions={<button className="btn pri" disabled={!a.graded || publishAll.isPending} onClick={() => confirm(`Publish ${a.graded} draft grade(s) to students?`) && publishAll.mutate()}><Icon n="upload" />Publish {a.graded || ''} draft grade{a.graded === 1 ? '' : 's'}</button>} />
    <div className="filters">
      <div className="field" style={{ flex: '1 1 320px' }}><label htmlFor="gr-a">Assessment</label><select className="inp" id="gr-a" value={a.id} onChange={e => setSp({ a: e.target.value })}>
        {list.data!.map(x => <option key={x.id} value={x.id}>{x.course_code} · {x.title}{x.to_grade ? ` (${x.to_grade} to grade)` : ''}</option>)}</select></div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', paddingBottom: 6 }}><span className="b teal">{a.to_grade} to grade</span><span className="b warn">{a.graded} draft</span><span className="b good">{a.published} published</span><span className="b out">{a.not_submitted} not submitted</span></div>
    </div>
    <div className="row"><div style={{ maxWidth: '100%', overflowX: 'auto' }}><Seg options={FILTERS} value={f} onChange={setF} /></div><span className="sp" />
      {missing.length > 0 && <button className="btn sm" disabled={remind.isPending} onClick={() => remind.mutate(missing.map((r: any) => r.student_id))}><Icon n="bell" />Remind {missing.length} not submitted</button>}</div>
    <div className="g g-12">
      <div className="card pad0"><div className="tbl-wrap" style={{ border: 0, maxHeight: '70vh', overflow: 'auto' }}>
        {queue.isLoading ? <Loading /> : queue.error ? <ErrorBox error={queue.error} retry={() => queue.refetch()} /> :
          <table className="t"><thead><tr><th>Student</th><th>Status</th><th className="n">Mark</th></tr></thead><tbody>
            {rows.map((r: any) => { const [k, l] = STATUS_BADGE[r.status] || ['out', r.status]; return <tr key={r.student_id} className={r.submission_id && r.submission_id === sel ? 'sel' : ''} style={{ cursor: r.submission_id ? 'pointer' : 'default' }}
              tabIndex={r.submission_id ? 0 : -1} onClick={() => r.submission_id && setSel(r.submission_id)} onKeyDown={e => e.key === 'Enter' && r.submission_id && setSel(r.submission_id)}>
              <td><div className="who"><Avatar name={r.name} /><div><div className="nm small">{r.name}</div><div className="sub">{r.submitted_at ? fmtDate(r.submitted_at, true) : r.student_no}</div></div></div></td>
              <td><Badge kind={k}>{l}</Badge></td><td className="n">{r.score ?? '—'}</td></tr> })}
            {!rows.length && <tr><td colSpan={3}><Empty icon="checkc" title="Nothing here">No submissions in this filter.</Empty></td></tr>}
          </tbody></table>}
      </div></div>
      <div className="card">{sel ? <SubmissionView key={sel} sid={sel} aid={a.id} llm={queue.data?.llm} /> : <Empty icon="clip" title="Select a submission">Choose a student on the left to review and grade their work.</Empty>}</div>
    </div>
  </>
}

function SubmissionView({ sid, aid, llm }: { sid: number; aid: string; llm: boolean }) {
  const qc = useQueryClient(); const toast = useToast()
  const q = useQuery({ queryKey: ['grading-sub', sid], queryFn: () => get<any>(`/api/lecturer/grading/submissions/${sid}`) })
  const [rb, setRb] = useState<string[]>([]); const [score, setScore] = useState(''); const [fb, setFb] = useState(''); const [reason, setReason] = useState('')
  const [err, setErr] = useState<string | null>(null); const [aiDraft, setAiDraft] = useState(false)
  useEffect(() => {
    if (!q.data) return
    const d = q.data; const n = d.assessment.rubric.length
    setRb(Array.from({ length: n }, (_, i) => d.rubric_scores?.[i] != null ? String(d.rubric_scores[i]) : ''))
    setScore(d.score != null ? String(d.score) : ''); setFb(d.feedback || ''); setReason(''); setErr(null); setAiDraft(false)
  }, [q.data])
  const refresh = () => { qc.invalidateQueries({ queryKey: ['grading-sub', sid] }); qc.invalidateQueries({ queryKey: ['grading-queue', aid] }); qc.invalidateQueries({ queryKey: ['grading-overview'] }) }
  const save = useMutation({ mutationFn: (body: any) => put(`/api/lecturer/grading/submissions/${sid}`, body), onError: (e: any) => setErr(e.message) })
  const pub = useMutation({ mutationFn: () => post(`/api/lecturer/grading/assessments/${aid}/publish`, { submission_ids: [sid] }), onError: (e: any) => setErr(e.message) })
  const ai = useMutation({ mutationFn: () => post<any>(`/api/lecturer/grading/submissions/${sid}/ai-feedback`), onSuccess: r => { setFb(r.draft); setAiDraft(true) }, onError: (e: any) => toast(e.message, true) })
  if (q.isLoading) return <Loading label="Opening submission…" />
  if (q.error) return <ErrorBox error={q.error} retry={() => q.refetch()} />
  const d = q.data; const A = d.assessment; const rubric = A.rubric as any[]
  const nums = rb.map(v => v === '' ? null : Number(v))
  const total = rubric.length ? (nums.every(v => v != null) ? nums.reduce((s, v) => s! + v!, 0) : null) : (score === '' ? null : Number(score))
  const published = d.raw_status === 'published'
  const store = async (publish: boolean) => {
    const bad = rubric.length ? nums.findIndex((v, i) => v != null && (isNaN(v) || v < 0 || v > rubric[i].max)) : (total != null && (isNaN(total) || total < 0 || total > A.max_score) ? 0 : -1)
    const m = bad >= 0 ? (rubric.length ? `“${rubric[bad].criterion}” must be between 0 and ${rubric[bad].max}.` : `The mark must be between 0 and ${A.max_score}.`)
      : (publish || published) && total == null ? (rubric.length ? 'Score every rubric criterion before publishing.' : 'Enter a mark before publishing.')
        : (publish || published) && !fb.trim() ? 'Add feedback before publishing.'
          : published && reason.trim().length < 5 ? 'Give a reason for changing a published grade (at least 5 characters).' : ''
    setErr(m || null); if (m) return
    try {
      await save.mutateAsync({ rubric_scores: nums, score: rubric.length ? null : total, feedback: fb, reason: published ? reason : null })
      if (publish && !published) await pub.mutateAsync()
      toast(published ? 'Grade changed and re-mark recorded' : publish ? `Grade published to ${d.student.first}` : 'Draft grade saved'); refresh()
    } catch { /* inline error */ }
  }
  const busy = save.isPending || pub.isPending
  return <>
    <div className="hd"><h3>{d.student.name}</h3><span className="xs muted">{d.student.student_no} · {d.submitted_at ? `submitted ${fmtDate(d.submitted_at, true)}` : 'not submitted'}{d.late ? ' · late' : ''}</span></div>
    {!d.submitted_at ? <Empty icon="clip" title="No submission yet" /> : <div className="g g2">
      <div className="card flat" style={{ minHeight: 260 }}>
        <div className="row sb"><b className="small"><Icon n="file" /> {d.file_name || 'Text submission'}</b>{d.answers?.words ? <span className="xs muted">{d.answers.words} words</span> : null}</div>
        {d.file_name && <button className="btn sm" style={{ marginTop: 8 }} onClick={() => download(`/api/lecturer/grading/submissions/${sid}/file`, d.file_name).catch((e: any) => toast(d.has_file ? e.message : 'The original file isn’t stored for this synthetic submission.', true))}><Icon n="download" />Download file</button>}
        {d.text ? <div style={{ marginTop: 12, fontFamily: 'var(--f-display)', fontSize: 14, lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{d.text}</div>
          : d.quiz ? <div className="col" style={{ marginTop: 10 }}>{d.quiz.map((x: any, i: number) => <div key={i} className="small"><b>{i + 1}.</b> {x.q} — {x.ok == null ? <span className="faint">no answer</span> : <Badge kind={x.ok ? 'good' : 'bad'}>{x.ok ? 'correct' : 'incorrect'}</Badge>}</div>)}</div>
            : <p className="small muted" style={{ marginTop: 12 }}>{d.file_name ? 'Download the file to read the full submission.' : 'No text was submitted.'}</p>}
      </div>
      <div className="col">
        <div className="eyebrow">{rubric.length ? 'Rubric' : 'Mark'}</div>
        {rubric.length ? rubric.map((c, i) => <div className="row" style={{ flexWrap: 'nowrap' }} key={i}><span className="small" style={{ flex: 1 }} title={c.desc}>{c.criterion}</span>
          <input className={`inp num ${nums[i] != null && (nums[i]! < 0 || nums[i]! > c.max) ? 'bad' : ''}`} type="number" min={0} max={c.max} step="0.5" style={{ width: 72 }} value={rb[i] ?? ''} aria-label={`${c.criterion} out of ${c.max}`} onChange={e => setRb(rb.map((x, k) => k === i ? e.target.value : x))} />
          <span className="xs muted">/ {c.max}</span></div>)
          : <div className="row" style={{ flexWrap: 'nowrap' }}><span className="small" style={{ flex: 1 }}>Overall mark</span><input className="inp num" type="number" min={0} max={A.max_score} step="0.5" style={{ width: 90 }} value={score} aria-label={`Mark out of ${A.max_score}`} onChange={e => setScore(e.target.value)} /><span className="xs muted">/ {A.max_score}</span></div>}
        <div className="row sb"><b>Total</b><b className="num">{total ?? '—'} / {A.max_score}</b></div>
        <Field label="Feedback to student" htmlFor="gr-fb"><textarea className="inp" id="gr-fb" rows={5} maxLength={8000} value={fb} onChange={e => { setFb(e.target.value) }} /></Field>
        {aiDraft && <Note icon="ai"><AiTag /> AI-drafted wording inserted. Edit and approve it before saving — the AI does not set marks.</Note>}
        <button className="btn sm ghost" style={{ alignSelf: 'flex-start' }} disabled={!llm || ai.isPending} title={llm ? '' : 'AI feedback drafting is not configured on this server'} onClick={() => ai.mutate()}>
          <Icon n="ai" />{ai.isPending ? 'Drafting…' : llm ? 'Suggest feedback wording' : 'AI wording unavailable'}</button>
        {published && <Field label="Reason for re-mark (audited)" htmlFor="gr-rs"><input className="inp" id="gr-rs" maxLength={500} value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. Second-marker moderation" /></Field>}
        <InlineErr msg={err} />
        <div className="row">{published ? <button className="btn pri" disabled={busy} onClick={() => store(false)}><Icon n="save" />Change published grade</button> : <>
          <button className="btn" disabled={busy} onClick={() => store(false)}><Icon n="save" />Save draft</button>
          <button className="btn pri" disabled={busy} onClick={() => store(true)}><Icon n="upload" />Publish grade</button></>}</div>
        <p className="xs muted">Marks are entered and published by the lecturer. AI can suggest wording only; it never sets the mark.</p>
      </div>
    </div>}
    <div style={{ marginTop: 14 }}><div className="eyebrow">Assessment history</div><div className="tl" style={{ marginTop: 6 }}>
      {d.history.map((h: any, i: number) => <div className={`it ${h.action.includes('Published') || h.action.includes('Changed') ? 'g' : 'n'}`} key={i}><b className="small">{h.action}{h.detail?.change ? `: ${h.detail.change}` : ''}</b>
        <div className="xs muted">{fmtDate(h.at, true)} · {h.by}{h.reason ? ` · “${h.reason}”` : ''}</div></div>)}
      {d.submitted_at && <div className="it n"><b className="small">Submitted</b><div className="xs muted">{fmtDate(d.submitted_at, true)}</div></div>}
    </div></div>
  </>
}
