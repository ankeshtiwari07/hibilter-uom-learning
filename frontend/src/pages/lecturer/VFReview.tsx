import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Icon } from '../../components/Icon'
import { AiTag, Avatar, Badge, Card, Empty, ErrorBox, Field, Loading, Note, PageHead, Seg, useToast } from '../../components/ui'
import { get, post } from '../../lib/api'
import { fmtDate, rel } from '../../lib/format'
import { InlineErr, Sel, useMyCourses } from './shared'

const KIND: Record<string, [string, string]> = { assisted: ['warn', 'Assisted completion'], low_conf: ['gold', 'Low-confidence evaluation'], flagged: ['bad', 'Flagged'] }
const VERDICT: Record<string, string> = { correct: 'good', partial: 'warn', incorrect: 'bad', unclear: 'out' }

export default function VFReview() {
  const [status, setStatus] = useState('open'); const [course, setCourse] = useState(''); const [kind, setKind] = useState('')
  const [sel, setSel] = useState<number | null>(null)
  const courses = useMyCourses()
  const q = useQuery({ queryKey: ['vf-review', status, course, kind], queryFn: () => get<any>(`/api/lecturer/vf/review?status=${status}${course ? `&course_id=${course}` : ''}${kind ? `&kind=${kind}` : ''}`) })
  const items = q.data?.items || []
  const cur = items.find((i: any) => i.id === sel) || items[0]
  return <>
    <PageHead title="Virtual faculty review queue" sub="Checkpoints completed with assisted learning, and AI evaluations the system was not confident about. Review the learner’s attempts and record what you did." />
    <div className="card" style={{ padding: '12px 14px' }}><div className="filters">
      <div className="field"><label>Status</label><Seg options={[['open', `Open${q.data ? ` (${q.data.counts.open})` : ''}`], ['resolved', `Resolved${q.data ? ` (${q.data.counts.resolved})` : ''}`], ['all', 'All']]} value={status} onChange={v => { setStatus(v); setSel(null) }} /></div>
      <Sel id="rv-c" label="Course" value={course} onChange={v => { setCourse(v); setSel(null) }} options={[['', 'All my courses'], ...(courses.data || []).filter(c => c.vf_enabled || c.lessons).map(c => [c.id, c.code] as [string, string])]} />
      <Sel id="rv-k" label="Reason" value={kind} onChange={v => { setKind(v); setSel(null) }} options={[['', 'All reasons'], ['assisted', 'Assisted completion'], ['low_conf', 'Low-confidence evaluation']]} />
    </div></div>
    {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} retry={() => q.refetch()} /> : !items.length ?
      <Empty icon="checkc" title={status === 'open' ? 'Nothing to review' : 'No items'}>{status === 'open' ? 'No assisted completions or low-confidence evaluations are waiting.' : 'Try another filter.'}</Empty> :
      <div className="g g-12">
        <div className="card pad0"><div className="list" style={{ maxHeight: 640, overflow: 'auto' }}>{items.map((i: any) => <button key={i.id} className="li" onClick={() => setSel(i.id)}
          style={{ textAlign: 'left', border: 0, width: '100%', font: 'inherit', color: 'inherit', cursor: 'pointer', padding: '10px 14px', background: cur?.id === i.id ? 'var(--surface-2)' : 'none' }}>
          <Avatar name={i.student.name} /><div className="bd"><div className="tt small">{i.student.name}</div><div className="ds">{i.course_code} · {i.checkpoint.id.toUpperCase()} · {rel(i.created_at)}</div></div>
          <Badge kind={i.status === 'open' ? KIND[i.kind]?.[0] || 'out' : 'good'}>{i.status === 'open' ? KIND[i.kind]?.[1] || i.kind : 'Resolved'}</Badge></button>)}</div></div>
        {cur && <Detail key={cur.id} it={cur} />}
      </div>}
  </>
}

function Detail({ it }: { it: any }) {
  const qc = useQueryClient(); const toast = useToast()
  const [note, setNote] = useState(''); const [err, setErr] = useState<string | null>(null)
  const m = useMutation({ mutationFn: () => post(`/api/lecturer/vf/review/${it.id}/resolve`, { note: note.trim() }),
    onSuccess: () => { toast('Marked as resolved and recorded in the audit log'); qc.invalidateQueries({ queryKey: ['vf-review'] }) }, onError: (e: any) => setErr(e.message) })
  return <Card title={<>{it.student.name} <span className="xs muted">{it.student.student_no}</span></>} actions={<Badge kind={KIND[it.kind]?.[0]}>{KIND[it.kind]?.[1] || it.kind}</Badge>}>
    <dl className="kv"><dt>Lesson</dt><dd>{it.course_code} · {it.lesson}</dd><dt>Checkpoint</dt><dd>{it.checkpoint.id.toUpperCase()} · {it.checkpoint.question}</dd>
      <dt>Outcome</dt><dd>{it.session?.outcome || '—'} · session {it.session?.status}</dd><dt>Raised</dt><dd>{fmtDate(it.created_at, true)}</dd></dl>
    <div className="eyebrow" style={{ marginTop: 12 }}>Attempts ({it.attempts.length})</div>
    {!it.attempts.length ? <Empty title="No attempts recorded" /> : <div className="col">{it.attempts.map((a: any) => <div key={a.n} className="card flat" style={{ padding: 10 }}>
      <div className="row"><b className="small">Attempt {a.n}</b><Badge kind={VERDICT[a.verdict] || 'out'}>{a.verdict}</Badge><span className="xs muted">{a.engine === 'claude' ? 'AI evaluator' : 'rubric patterns'} · {a.confidence} confidence{a.hints_before ? ` · after ${a.hints_before} hint${a.hints_before > 1 ? 's' : ''}` : ''}</span></div>
      <p className="small" style={{ margin: '6px 0', fontFamily: 'var(--f-display)' }}>“{a.answer}”</p>
      <div className="row xs">{a.found.map((x: string) => <span key={x} className="b good">✓ {x}</span>)}{a.missing.map((x: string) => <span key={x} className="b out">missing: {x}</span>)}{a.mis.map((x: string) => <span key={x} className="b bad">{x}</span>)}</div>
      {a.ai_feedback && <div className="xs muted" style={{ marginTop: 6 }}><AiTag /> {a.ai_feedback}</div>}
    </div>)}</div>}
    {it.checkpoint.model && <Note icon="bulb"><b>Model answer:</b> {it.checkpoint.model}</Note>}
    {it.status === 'resolved' ? <Note kind="good" icon="checkc"><b>Resolved</b> by {it.resolved_by || '—'} {rel(it.resolved_at)}: {it.note}</Note> : <div style={{ marginTop: 12 }}>
      <Field label="Resolution note (audited)" htmlFor="rv-note" hint="e.g. Discussed in tutorial; understands the AI–ML relationship now."><textarea className="inp" id="rv-note" rows={3} maxLength={2000} value={note} onChange={e => setNote(e.target.value)} /></Field>
      <InlineErr msg={err} />
      <div className="row" style={{ marginTop: 8 }}><button className="btn pri" disabled={m.isPending} onClick={() => note.trim().length < 3 ? setErr('Write a short note (at least 3 characters).') : m.mutate()}><Icon n="checkc" />Mark resolved</button></div>
    </div>}
  </Card>
}
