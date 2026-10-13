import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Icon } from '../../components/Icon'
import { AiTag, Badge, Card, Empty, ErrorBox, Field, Loading, Modal, Note, PageHead, Switch, Tabs, useToast } from '../../components/ui'
import { del, get, post, put } from '../../lib/api'
import { fmtDate, rel } from '../../lib/format'
import { ErrList, ListEditor, useMyCourses } from './shared'

type Rx = { re: string; flags?: string }
type Concept = { id: string; label: string; required: boolean; rx: Rx[] }
type Mis = { id: string; label: string; rx: Rx[] }
type CP = { id: string; mandatory: boolean; maxAttempts: number; question: string; concepts: Concept[]; misconceptions: Mis[]; hints: string[]; model: string; reteach: string; ack?: string }
type Seg = { id: string; title: string; slide?: string | null; speech: string[]; simpler: string[]; checkpoint: CP }
type Content = { title: string; module: string; dur: number; objectives: string[]; segments: Seg[]; closing: string[]; side_answers?: Record<string, string>; concept_ask?: Record<string, string> }
type Sample = { answer: string; expected: string }
const VERDICTS = ['correct', 'partial', 'incorrect', 'unclear']
const SLIDES: [string, string][] = [['', 'Text slide'], ['nested', 'Nested circles (AI ⊃ ML ⊃ DL)'], ['pipeline', 'Training pipeline'], ['apps', 'Applications & risks']]
const ID = /^[A-Za-z0-9_-]{1,32}$/

function validate(c: Content): string[] {
  const e: string[] = []
  if ((c.title || '').trim().length < 3) e.push('Give the lesson a title (at least 3 characters).')
  if (!(c.dur >= 1 && c.dur <= 240)) e.push('Duration must be between 1 and 240 minutes.')
  if (!c.segments.length) e.push('Add at least one segment.')
  if (!c.closing.filter(x => x.trim()).length) e.push('Add at least one closing line.')
  const cps = new Set<string>()
  if (c.segments.length && !c.segments.some(s => s.checkpoint.mandatory)) e.push('At least one checkpoint must be mandatory.')
  c.segments.forEach((s, i) => {
    const n = `Segment ${i + 1}`; const cp = s.checkpoint
    if (s.title.trim().length < 2) e.push(`${n}: add a title.`)
    if (!s.speech.filter(x => x.trim()).length) e.push(`${n}: add at least one spoken line.`)
    if (!s.simpler.filter(x => x.trim()).length) e.push(`${n}: add at least one simpler line.`)
    if (!ID.test(cp.id)) e.push(`${n}: checkpoint id must be letters, numbers, - or _.`)
    if (cps.has(cp.id)) e.push(`${n}: checkpoint id “${cp.id}” is used twice.`); cps.add(cp.id)
    if (cp.question.trim().length < 5) e.push(`${n}: write the checkpoint question.`)
    if (!cp.concepts.length) e.push(`${n}: add at least one concept.`)
    if (!cp.concepts.some(x => x.required)) e.push(`${n}: mark at least one concept as required.`)
    cp.concepts.forEach((x, k) => {
      if (!ID.test(x.id)) e.push(`${n}, concept ${k + 1}: id must be letters, numbers, - or _.`)
      if (x.label.trim().length < 2) e.push(`${n}, concept ${k + 1}: add a description.`)
      if (!x.rx.length) e.push(`${n}, concept ${k + 1}: add at least one fallback pattern.`)
      x.rx.forEach(r => { try { new RegExp(r.re) } catch { e.push(`${n}, concept ${k + 1}: “${r.re.slice(0, 30)}” is not a valid pattern.`) } })
    })
    if (new Set(cp.concepts.map(x => x.id)).size !== cp.concepts.length) e.push(`${n}: concept ids must be unique.`)
    if (!cp.hints.filter(x => x.trim()).length) e.push(`${n}: add at least one hint.`)
    if (cp.model.trim().length < 5) e.push(`${n}: add a model answer.`)
    if (cp.reteach.trim().length < 5) e.push(`${n}: add a re-teach explanation.`)
  })
  return e
}

const clean = (c: Content): Content => ({
  ...c, objectives: c.objectives.map(x => x.trim()).filter(Boolean), closing: c.closing.map(x => x.trim()).filter(Boolean),
  segments: c.segments.map(s => ({ ...s, slide: s.slide || null, speech: s.speech.map(x => x.trim()).filter(Boolean), simpler: s.simpler.map(x => x.trim()).filter(Boolean),
    checkpoint: { ...s.checkpoint, hints: s.checkpoint.hints.map(x => x.trim()).filter(Boolean), ack: s.checkpoint.ack || '' } })),
})

export default function LessonEditor() {
  const [sp, setSp] = useSearchParams()
  const lessons = useQuery({ queryKey: ['lect-lessons'], queryFn: () => get<any[]>('/api/lecturer/lessons') })
  const [creating, setCreating] = useState(false)
  if (lessons.isLoading) return <Loading />
  if (lessons.error) return <ErrorBox error={lessons.error} retry={() => lessons.refetch()} />
  const ls = lessons.data || []
  const lid = sp.get('lesson') || ls[0]?.id
  return <>
    {!ls.length ? <><PageHead no={16} title="Edit lesson" actions={<button className="btn pri" onClick={() => setCreating(true)}><Icon n="plus" />New lesson</button>} />
      <Empty icon="cap" title="No lessons yet">Create a virtual faculty lesson for one of your courses.</Empty></>
      : <Editor key={lid} lid={lid!} lessons={ls} onPick={id => setSp({ lesson: id })} onNew={() => setCreating(true)} />}
    {creating && <NewLesson onClose={() => setCreating(false)} onDone={id => { setCreating(false); lessons.refetch(); setSp({ lesson: id }) }} />}
  </>
}

function NewLesson({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const courses = useMyCourses(); const toast = useToast()
  const [f, setF] = useState({ course_id: '', title: '', module: '' }); const [err, setErr] = useState<string | null>(null)
  const m = useMutation({ mutationFn: () => post<any>('/api/lecturer/lessons', { ...f, course_id: f.course_id || courses.data?.[0]?.id }), onSuccess: r => { toast('Lesson created as a draft'); onDone(r.id) }, onError: (e: any) => setErr(e.message) })
  return <Modal title="New virtual faculty lesson" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button>
    <button className="btn pri" disabled={m.isPending} onClick={() => f.title.trim().length < 3 ? setErr('Give the lesson a title (at least 3 characters).') : m.mutate()}>Create draft</button></>}>
    <div className="col">
      <Field label="Course" htmlFor="nl-c"><select className="inp" id="nl-c" value={f.course_id || courses.data?.[0]?.id || ''} onChange={e => setF({ ...f, course_id: e.target.value })}>{(courses.data || []).map(c => <option key={c.id} value={c.id}>{c.code} · {c.title}</option>)}</select></Field>
      <Field label="Lesson title" htmlFor="nl-t" error={err}><input className="inp" id="nl-t" value={f.title} maxLength={300} onChange={e => setF({ ...f, title: e.target.value })} /></Field>
      <Field label="Module" htmlFor="nl-m" hint="e.g. Module 2 · How Machines Learn"><input className="inp" id="nl-m" value={f.module} maxLength={200} onChange={e => setF({ ...f, module: e.target.value })} /></Field>
    </div>
  </Modal>
}

function Editor({ lid, lessons, onPick, onNew }: { lid: string; lessons: any[]; onPick: (id: string) => void; onNew: () => void }) {
  const qc = useQueryClient(); const toast = useToast()
  const q = useQuery({ queryKey: ['lect-lesson', lid], queryFn: () => get<any>(`/api/lecturer/lessons/${lid}`) })
  const [c, setC] = useState<Content | null>(null); const [dirty, setDirty] = useState(false)
  const [seg, setSeg] = useState(0); const [errors, setErrors] = useState<string[]>([])
  useEffect(() => { if (q.data) { setC(JSON.parse(JSON.stringify(q.data.content))); setDirty(false) } }, [q.data])
  const refresh = () => { qc.invalidateQueries({ queryKey: ['lect-lesson', lid] }); qc.invalidateQueries({ queryKey: ['lect-lessons'] }) }
  const saveDraft = useMutation({ mutationFn: () => put(`/api/lecturer/lessons/${lid}/draft`, clean(c!)), onError: (e: any) => setErrors([e.message]) })
  const publish = useMutation({ mutationFn: () => post<any>(`/api/lecturer/lessons/${lid}/publish`), onError: (e: any) => setErrors([e.message]) })
  const discard = useMutation({ mutationFn: () => del(`/api/lecturer/lessons/${lid}/draft`), onSuccess: () => { toast('Draft discarded'); refresh() }, onError: (e: any) => toast(e.message, true) })
  const unpublish = useMutation({ mutationFn: () => post(`/api/lecturer/lessons/${lid}/unpublish`), onSuccess: () => { toast('Unpublished — students can no longer start this lesson'); refresh() }, onError: (e: any) => toast(e.message, true) })
  if (q.isLoading || (!c && !q.error)) return <Loading />
  if (q.error) return <ErrorBox error={q.error} retry={() => q.refetch()} />
  const L = q.data
  const upd = (fn: (c: Content) => Content) => { setC(x => fn(x!)); setDirty(true) }
  const updSeg = (i: number, fn: (s: Seg) => Seg) => upd(x => ({ ...x, segments: x.segments.map((s, k) => k === i ? fn(s) : s) }))
  const onSave = async () => {
    const e = validate(c!); setErrors(e); if (e.length) return
    await saveDraft.mutateAsync(); setDirty(false); toast('Draft saved'); refresh()
  }
  const onPublish = async () => {
    const e = validate(c!); setErrors(e); if (e.length) return
    try {
      if (dirty || !L.draft) { await saveDraft.mutateAsync(); setDirty(false) }
      const r = await publish.mutateAsync(); toast(`Published version ${r.version} to ${L.course_code} students`); setErrors([]); refresh()
    } catch { /* errors shown inline */ }
  }
  const busy = saveDraft.isPending || publish.isPending
  const s = c!.segments[Math.min(seg, c!.segments.length - 1)]
  const statusChip = L.draft || dirty ? <Badge kind="warn">{dirty ? 'Unsaved changes' : `Draft ${L.draft.no}`}</Badge> : <Badge kind={L.status === 'published' ? 'good' : 'warn'}>{L.status === 'published' ? `Published v${L.version}` : 'Draft'}</Badge>
  return <>
    <PageHead no={16} title="Edit lesson" sub={`${L.course_code} · ${c!.module || 'No module'} · ${c!.title}`}
      actions={<>{statusChip}<button className="btn" onClick={onSave} disabled={busy}><Icon n="save" />{saveDraft.isPending ? 'Saving…' : 'Save draft'}</button>
        <button className="btn pri" onClick={onPublish} disabled={busy}><Icon n="upload" />{publish.isPending ? 'Publishing…' : 'Publish'}</button></>} />
    <div className="filters">
      <div className="field" style={{ flex: '1 1 320px' }}><label htmlFor="le-pick">Lesson</label><select className="inp" id="le-pick" value={lid} onChange={e => { if (!dirty || confirm('Discard unsaved changes?')) onPick(e.target.value) }}>
        {lessons.map(l => <option key={l.id} value={l.id}>{l.title} · v{l.version}{l.draft ? ` · draft ${l.draft.no}` : ''}{l.status !== 'published' ? ' · unpublished' : ''}</option>)}</select></div>
      <button className="btn" onClick={onNew}><Icon n="plus" />New lesson</button>
      {L.draft && <button className="btn ghost" disabled={discard.isPending} onClick={() => confirm('Discard the saved draft and return to the published version?') && discard.mutate()}>Discard draft</button>}
      {L.status === 'published' && <button className="btn ghost" disabled={unpublish.isPending} onClick={() => confirm('Unpublish? Students will no longer be able to start this lesson.') && unpublish.mutate()}>Unpublish</button>}
    </div>
    <ErrList errors={errors} />
    {L.draft && !dirty && <Note icon="info">Draft {L.draft.no} saved {rel(L.draft.at)} by {L.draft.by}. Students still see published version {L.version} until you publish.</Note>}
    <div className="g g-21">
      <div className="stack">
        <Card title="Lesson details">
          <div className="g g2">
            <div style={{ gridColumn: '1/-1' }}><Field label="Lesson title" htmlFor="le-t"><input className={`inp ${c!.title.trim().length < 3 ? 'bad' : ''}`} id="le-t" maxLength={300} value={c!.title} onChange={e => upd(x => ({ ...x, title: e.target.value }))} /></Field></div>
            <Field label="Module" htmlFor="le-m"><input className="inp" id="le-m" maxLength={200} value={c!.module} onChange={e => upd(x => ({ ...x, module: e.target.value }))} /></Field>
            <Field label="Duration (minutes)" htmlFor="le-dur"><input className="inp" id="le-dur" type="number" min={1} max={240} value={c!.dur} onChange={e => upd(x => ({ ...x, dur: +e.target.value }))} /></Field>
          </div>
          <div className="field" style={{ marginTop: 10 }}><label>Learning objectives</label><ListEditor items={c!.objectives} max={10} onChange={v => upd(x => ({ ...x, objectives: v }))} placeholder="Add objective" label="Objective" /></div>
        </Card>
        <Card title="Segments & checkpoints" actions={<button className="btn sm" onClick={() => { upd(x => ({ ...x, segments: [...x.segments, newSeg(x.segments)] })); setSeg(c!.segments.length) }} disabled={c!.segments.length >= 12}><Icon n="plus" />Add segment</button>}>
          <Tabs tabs={c!.segments.map((x, i) => [String(i), `${i + 1}. ${x.title.slice(0, 22) || 'Untitled'}`])} value={String(Math.min(seg, c!.segments.length - 1))} onChange={v => setSeg(+v)} />
          {s && <SegEditor key={`${s.id}-${seg}`} s={s} idx={Math.min(seg, c!.segments.length - 1)} total={c!.segments.length} onChange={fn => updSeg(Math.min(seg, c!.segments.length - 1), fn)}
            onMove={d => { const i = Math.min(seg, c!.segments.length - 1); upd(x => { const a = [...x.segments]; const [m] = a.splice(i, 1); a.splice(i + d, 0, m); return { ...x, segments: a } }); setSeg(i + d) }}
            onRemove={() => { if (confirm(`Remove segment “${s.title}” and its checkpoint?`)) { upd(x => ({ ...x, segments: x.segments.filter(y => y !== s) })); setSeg(0) } }} />}
        </Card>
        <Card title="Closing lines"><p className="xs muted">Spoken at the end. Use {'{name}'} for the learner’s first name.</p>
          <LinesEditor lines={c!.closing} onChange={v => upd(x => ({ ...x, closing: v }))} label="Closing line" max={10} /></Card>
      </div>
      <div className="stack">
        <Card title="Make it interactive" actions={<AiTag label="VF" />}>
          <p className="small muted">A digital lecturer teaches these lines and pauses at each checkpoint. Choose lecturers and progression rules on the configuration screen.</p>
          <Link className="btn sm teal" to={`/vf-config?lesson=${lid}`} style={{ marginTop: 10 }}><Icon n="cog" />Configure digital lecturer</Link>
        </Card>
        {s && <Calibration lid={lid} cp={s.checkpoint} saved={L.calibration?.[s.checkpoint.id] || []} llm={L.llm} dirty={dirty} onSaved={refresh} />}
        <Card title="Version history">
          <div className="tl">
            {(L.draft || dirty) && <div className="it"><b className="small">{dirty ? 'Unsaved edits' : `Draft ${L.draft.no}`}</b><div className="xs muted">{dirty ? 'now · you' : `${rel(L.draft.at)} · ${L.draft.by}`}</div></div>}
            {L.versions.map((v: any) => <div className="it n" key={v.version}><b className="small">Published v{v.version}{v.version === L.version && L.status === 'published' ? ' (live)' : ''}</b><div className="xs muted">{fmtDate(v.at, true)} · {v.by || 'System'}</div></div>)}
            {!L.versions.length && <div className="it n"><b className="small">Never published</b></div>}
          </div>
          <p className="xs muted" style={{ marginTop: 8 }}>{L.sessions} learner session{L.sessions === 1 ? '' : 's'} recorded. Publishing creates a new version; sessions already in progress keep their version number.</p>
        </Card>
      </div>
    </div>
  </>
}

function newSeg(segs: Seg[]): Seg {
  let n = segs.length + 1; while (segs.some(s => s.id === `seg${n}` || s.checkpoint.id === `cp${n}`)) n++
  return { id: `seg${n}`, title: 'New segment', slide: null, speech: [''], simpler: [''], checkpoint: { id: `cp${n}`, mandatory: true, maxAttempts: 3, question: '', concepts: [{ id: 'idea', label: '', required: true, rx: [] }], misconceptions: [], hints: [''], model: '', reteach: '', ack: '' } }
}

function LinesEditor({ lines, onChange, label, max = 30 }: { lines: string[]; onChange: (v: string[]) => void; label: string; max?: number }) {
  return <div className="col">{lines.map((l, i) => <div className="row" key={i} style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}>
    <span className="xs muted mono" style={{ paddingTop: 8, minWidth: 18 }}>{i + 1}</span>
    <textarea className={`inp ${!l.trim() ? 'bad' : ''}`} rows={2} maxLength={600} value={l} aria-label={`${label} ${i + 1}`} onChange={e => onChange(lines.map((x, k) => k === i ? e.target.value : x))} />
    <button className="iconbtn" aria-label={`Remove ${label.toLowerCase()} ${i + 1}`} onClick={() => onChange(lines.filter((_, k) => k !== i))}><Icon n="x" /></button></div>)}
    {lines.length < max && <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => onChange([...lines, ''])}><Icon n="plus" />Add line</button>}</div>
}

const rxText = (rx: Rx[]) => rx.map(r => r.re).join('\n')
const rxParse = (t: string): Rx[] => t.split('\n').map(x => x.trim()).filter(Boolean).map(re => ({ re, flags: 'i' }))

/** One regular expression per line; keeps the raw text while typing and stays in sync when the list changes. */
function RxArea({ id, rx, onChange, rows }: { id: string; rx: Rx[]; onChange: (rx: Rx[]) => void; rows: number }) {
  const [t, setT] = useState(rxText(rx))
  useEffect(() => { if (rxText(rxParse(t)) !== rxText(rx)) setT(rxText(rx)) }, [rx]) // eslint-disable-line
  const bad = rxParse(t).some(r => { try { new RegExp(r.re); return false } catch { return true } })
  return <textarea className={`inp mono ${bad || !rx.length ? 'bad' : ''}`} id={id} rows={rows} style={{ fontSize: 12 }} value={t} spellCheck={false}
    onChange={e => { setT(e.target.value); onChange(rxParse(e.target.value)) }} />
}

function SegEditor({ s, idx, total, onChange, onMove, onRemove }: { s: Seg; idx: number; total: number; onChange: (fn: (s: Seg) => Seg) => void; onMove: (d: number) => void; onRemove: () => void }) {
  const cp = s.checkpoint
  const setCp = (fn: (c: CP) => CP) => onChange(x => ({ ...x, checkpoint: fn(x.checkpoint) }))
  const [sub, setSub] = useState('teach')
  return <div className="col" style={{ marginTop: 10 }}>
    <div className="g g2">
      <Field label="Segment title" htmlFor="sg-t"><input className="inp" id="sg-t" maxLength={200} value={s.title} onChange={e => onChange(x => ({ ...x, title: e.target.value }))} /></Field>
      <Field label="Slide" htmlFor="sg-sl"><select className="inp" id="sg-sl" value={s.slide || ''} onChange={e => onChange(x => ({ ...x, slide: e.target.value || null }))}>{SLIDES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
    </div>
    <div className="row"><button className="btn sm ghost" disabled={!idx} onClick={() => onMove(-1)}>Move earlier</button><button className="btn sm ghost" disabled={idx === total - 1} onClick={() => onMove(1)}>Move later</button>
      <span className="sp" /><button className="btn sm ghost" disabled={total <= 1} onClick={onRemove}><Icon n="x" />Remove segment</button></div>
    <Tabs tabs={[['teach', 'Spoken lines'], ['simpler', 'Simpler lines'], ['cp', `Checkpoint ${cp.id.toUpperCase()}`]]} value={sub} onChange={setSub} />
    {sub === 'teach' && <LinesEditor lines={s.speech} onChange={v => onChange(x => ({ ...x, speech: v }))} label="Spoken line" />}
    {sub === 'simpler' && <><p className="xs muted">Used when the learner asks for a simpler explanation.</p><LinesEditor lines={s.simpler} onChange={v => onChange(x => ({ ...x, simpler: v }))} label="Simpler line" /></>}
    {sub === 'cp' && <div className="col">
      <div className="g g3">
        <Field label="Checkpoint id" htmlFor="cp-id"><input className={`inp mono ${!ID.test(cp.id) ? 'bad' : ''}`} id="cp-id" maxLength={32} value={cp.id} onChange={e => setCp(c => ({ ...c, id: e.target.value.trim() }))} /></Field>
        <Field label="Retry limit" htmlFor="cp-max"><select className="inp" id="cp-max" value={cp.maxAttempts} onChange={e => setCp(c => ({ ...c, maxAttempts: +e.target.value }))}>{[1, 2, 3, 4, 5].map(n => <option key={n}>{n}</option>)}</select></Field>
        <div className="field"><label>&nbsp;</label><Switch id="cp-mand" checked={cp.mandatory} onChange={v => setCp(c => ({ ...c, mandatory: v }))} label="Mandatory" /></div>
      </div>
      <Field label="Question" htmlFor="cp-q"><textarea className="inp" id="cp-q" rows={2} maxLength={500} value={cp.question} onChange={e => setCp(c => ({ ...c, question: e.target.value }))} /></Field>
      <div className="eyebrow">Expected concepts</div>
      <p className="xs muted" style={{ margin: 0 }}>The AI identifies these in the learner’s own words. Fallback patterns (one regular expression per line, case-insensitive) are used when the AI is unavailable. Patterns are never shown to students.</p>
      {cp.concepts.map((x, k) => <div className="card flat" key={k} style={{ padding: 10 }}>
        <div className="g g3">
          <Field label="Id" htmlFor={`co-id-${k}`}><input className={`inp mono ${!ID.test(x.id) ? 'bad' : ''}`} id={`co-id-${k}`} maxLength={32} value={x.id} onChange={e => setCp(c => ({ ...c, concepts: c.concepts.map((y, z) => z === k ? { ...y, id: e.target.value.trim() } : y) }))} /></Field>
          <div style={{ gridColumn: 'span 2' }}><Field label="Description" htmlFor={`co-l-${k}`}><input className="inp" id={`co-l-${k}`} maxLength={200} value={x.label} onChange={e => setCp(c => ({ ...c, concepts: c.concepts.map((y, z) => z === k ? { ...y, label: e.target.value } : y) }))} /></Field></div>
        </div>
        <Field label="Fallback patterns" htmlFor={`co-rx-${k}`}><RxArea id={`co-rx-${k}`} rows={Math.min(5, Math.max(2, x.rx.length))} rx={x.rx}
          onChange={rx => setCp(c => ({ ...c, concepts: c.concepts.map((y, z) => z === k ? { ...y, rx } : y) }))} /></Field>
        <div className="row"><Switch id={`co-req-${k}`} checked={x.required} onChange={v => setCp(c => ({ ...c, concepts: c.concepts.map((y, z) => z === k ? { ...y, required: v } : y) }))} label="Required to pass" />
          <span className="sp" /><button className="btn sm ghost" disabled={cp.concepts.length <= 1} onClick={() => setCp(c => ({ ...c, concepts: c.concepts.filter((_, z) => z !== k) }))}><Icon n="x" />Remove</button></div>
      </div>)}
      <button className="btn sm" style={{ alignSelf: 'flex-start' }} disabled={cp.concepts.length >= 10} onClick={() => setCp(c => ({ ...c, concepts: [...c.concepts, { id: `c${c.concepts.length + 1}`, label: '', required: false, rx: [] }] }))}><Icon n="plus" />Add concept</button>
      <div className="eyebrow">Misconceptions</div>
      {cp.misconceptions.map((x, k) => <div className="card flat" key={k} style={{ padding: 10 }}>
        <div className="g g3">
          <Field label="Id" htmlFor={`mi-id-${k}`}><input className="inp mono" id={`mi-id-${k}`} maxLength={32} value={x.id} onChange={e => setCp(c => ({ ...c, misconceptions: c.misconceptions.map((y, z) => z === k ? { ...y, id: e.target.value.trim() } : y) }))} /></Field>
          <div style={{ gridColumn: 'span 2' }}><Field label="Description" htmlFor={`mi-l-${k}`}><input className="inp" id={`mi-l-${k}`} maxLength={200} value={x.label} onChange={e => setCp(c => ({ ...c, misconceptions: c.misconceptions.map((y, z) => z === k ? { ...y, label: e.target.value } : y) }))} /></Field></div>
        </div>
        <Field label="Fallback patterns" htmlFor={`mi-rx-${k}`}><RxArea id={`mi-rx-${k}`} rows={2} rx={x.rx} onChange={rx => setCp(c => ({ ...c, misconceptions: c.misconceptions.map((y, z) => z === k ? { ...y, rx } : y) }))} /></Field>
        <button className="btn sm ghost" onClick={() => setCp(c => ({ ...c, misconceptions: c.misconceptions.filter((_, z) => z !== k) }))}><Icon n="x" />Remove</button>
      </div>)}
      <button className="btn sm" style={{ alignSelf: 'flex-start' }} disabled={cp.misconceptions.length >= 10} onClick={() => setCp(c => ({ ...c, misconceptions: [...c.misconceptions, { id: `m${c.misconceptions.length + 1}`, label: '', rx: [] }] }))}><Icon n="plus" />Add misconception</button>
      <div className="eyebrow">Hints (given in order)</div>
      <LinesEditor lines={cp.hints} onChange={v => setCp(c => ({ ...c, hints: v }))} label="Hint" max={5} />
      <Field label="Model answer" htmlFor="cp-model"><textarea className="inp" id="cp-model" rows={3} maxLength={1200} value={cp.model} onChange={e => setCp(c => ({ ...c, model: e.target.value }))} /></Field>
      <Field label="Re-teach explanation" htmlFor="cp-rt" hint="Spoken when the learner asks to hear it explained differently."><textarea className="inp" id="cp-rt" rows={3} maxLength={2000} value={cp.reteach} onChange={e => setCp(c => ({ ...c, reteach: e.target.value }))} /></Field>
      <Field label="Acknowledgement when correct" htmlFor="cp-ack" hint="Optional. Defaults to the model answer."><input className="inp" id="cp-ack" maxLength={600} value={cp.ack || ''} onChange={e => setCp(c => ({ ...c, ack: e.target.value }))} /></Field>
    </div>}
  </div>
}

function Calibration({ lid, cp, saved, llm, dirty, onSaved }: { lid: string; cp: CP; saved: Sample[]; llm: boolean; dirty: boolean; onSaved: () => void }) {
  const toast = useToast()
  const [rows, setRows] = useState<Sample[]>(saved); const [changed, setChanged] = useState(false)
  const [engine, setEngine] = useState('rubric'); const [res, setRes] = useState<any>(null)
  const savedKey = useMemo(() => JSON.stringify(saved), [saved])
  useEffect(() => { setRows(saved); setChanged(false); setRes(null) }, [cp.id, savedKey]) // eslint-disable-line
  const save = useMutation({ mutationFn: () => put(`/api/lecturer/lessons/${lid}/calibration/${cp.id}`, { samples: rows.filter(r => r.answer.trim()) }),
    onSuccess: () => { toast('Calibration answers saved'); setChanged(false); onSaved() }, onError: (e: any) => toast(e.message, true) })
  const run = useMutation({ mutationFn: () => post<any>(`/api/lecturer/lessons/${lid}/calibrate`, { engine, cp_id: cp.id }), onSuccess: r => setRes(r.checkpoints[cp.id]), onError: (e: any) => toast(e.message, true) })
  const n = rows.filter(r => r.answer.trim()).length
  return <Card title={`Calibration · ${cp.id.toUpperCase()}`}>
    <p className="xs muted" style={{ marginTop: 0 }}>Label sample answers with the verdict you expect, then check the evaluator agrees. With 5 or more samples, publishing is blocked below 80% agreement.</p>
    <div className="col">{rows.map((r, i) => <div className="row" key={i} style={{ flexWrap: 'wrap', alignItems: 'flex-start', gap: 6, borderBottom: '1px solid var(--line)', paddingBottom: 8 }}>
      <textarea className="inp" style={{ flex: '1 1 100%' }} rows={2} maxLength={1200} value={r.answer} placeholder="A learner’s answer" aria-label={`Sample answer ${i + 1}`} onChange={e => { setRows(rows.map((x, k) => k === i ? { ...x, answer: e.target.value } : x)); setChanged(true) }} />
      <span className="xs muted">Expected</span><select className="inp" style={{ width: 'auto', flex: 1 }} value={r.expected} aria-label={`Expected verdict ${i + 1}`} onChange={e => { setRows(rows.map((x, k) => k === i ? { ...x, expected: e.target.value } : x)); setChanged(true) }}>{VERDICTS.map(v => <option key={v}>{v}</option>)}</select>
      <button className="iconbtn" aria-label={`Remove sample ${i + 1}`} onClick={() => { setRows(rows.filter((_, k) => k !== i)); setChanged(true) }}><Icon n="x" /></button></div>)}
      {!rows.length && <Empty icon="target" title="No sample answers yet">Add answers you have seen from real learners.</Empty>}
    </div>
    <div className="row" style={{ marginTop: 8 }}>
      <button className="btn sm" disabled={rows.length >= 50} onClick={() => { setRows([...rows, { answer: '', expected: 'correct' }]); setChanged(true) }}><Icon n="plus" />Add sample</button>
      <button className="btn sm pri" disabled={!changed || save.isPending} onClick={() => save.mutate()}><Icon n="save" />Save samples</button>
    </div>
    <div className="row" style={{ marginTop: 10 }}>
      <select className="inp" style={{ width: 'auto' }} value={engine} aria-label="Evaluator" onChange={e => setEngine(e.target.value)}><option value="rubric">Rubric (patterns)</option><option value="auto" disabled={!llm}>Auto (Claude, rubric fallback)</option><option value="claude" disabled={!llm}>Claude only</option></select>
      <button className="btn sm teal" disabled={!n || changed || run.isPending} onClick={() => run.mutate()}><Icon n="target" />{run.isPending ? 'Running…' : 'Run calibration'}</button>
    </div>
    {changed && <span className="hint">Save the samples before running calibration.</span>}
    {dirty && <span className="hint">Calibration runs against the last saved draft — save your edits first.</span>}
    {res && <div style={{ marginTop: 10 }}>
      <div className="row"><b className="num" style={{ fontSize: 22 }}>{res.pct ?? '—'}%</b><span className="small muted">agreement on {res.n} answer{res.n === 1 ? '' : 's'}</span>
        {res.blocking ? <Badge kind="bad">Blocks publishing</Badge> : res.gated ? <Badge kind="good">Meets 80%</Badge> : <Badge kind="out">Needs 5+ samples to gate</Badge>}</div>
      <div className="tbl-wrap" style={{ marginTop: 6 }}><table className="t"><thead><tr><th>Answer</th><th>Expected</th><th>Evaluator</th></tr></thead>
        <tbody>{res.rows.map((r: any, i: number) => <tr key={i}><td className="small" style={{ minWidth: 160 }}>{r.answer}{r.missing?.length ? <div className="xs muted">missing: {r.missing.join(', ')}</div> : null}</td>
          <td>{r.expected}</td><td><Badge kind={r.ok ? 'good' : 'bad'}>{r.got || r.error}</Badge></td></tr>)}</tbody></table></div>
    </div>}
  </Card>
}
