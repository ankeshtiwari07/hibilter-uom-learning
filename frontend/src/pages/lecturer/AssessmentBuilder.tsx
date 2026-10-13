import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Icon } from '../../components/Icon'
import { Badge, Card, Empty, ErrorBox, Field, Loading, Modal, PageHead, Switch, Tabs, useToast } from '../../components/ui'
import { del, get, post, put } from '../../lib/api'
import { fmtDate } from '../../lib/format'
import { ErrList, fromLocalInput, toLocalInput, useMyCourses } from './shared'

type Q = { q: string; o: string[]; a: number | null; ex: string; m: number }
type Cr = { criterion: string; max: number; desc: string }
type A = { id?: string; course_id: string; title: string; type: string; due: string | null; weight: number; max_score: number; instructions: string; questions: Q[]; rubric: Cr[]; settings: any; status: string; submissions?: number }
const DEF_SETTINGS = { time_limit: null, attempts: 1, late_policy: 'accept', late_penalty: 10, shuffle: true, show_answers: true, accommodations: true, accepted_files: 'PDF, DOCX', reminders: [] }
const blankQ = (): Q => ({ q: '', o: ['', '', '', ''], a: null, ex: '', m: 1 })
const blank = (course_id: string, type: string): A => ({ course_id, title: '', type, due: null, weight: 10, max_score: type === 'quiz' ? 10 : 100, instructions: '', questions: type === 'quiz' ? [blankQ()] : [],
  rubric: type === 'quiz' ? [] : [{ criterion: '', max: 100, desc: '' }], settings: { ...DEF_SETTINGS }, status: 'draft' })

function check(a: A, publishing: boolean): string[] {
  const e: string[] = []
  if (a.title.trim().length < 3) e.push('Give the assessment a title (at least 3 characters).')
  if (!(a.max_score >= 1)) e.push('Maximum score must be at least 1.')
  if (!(a.weight >= 0 && a.weight <= 100)) e.push('Weight must be between 0 and 100%.')
  if (a.settings.time_limit != null && !(a.settings.time_limit >= 1 && a.settings.time_limit <= 600)) e.push('Time limit must be 1–600 minutes.')
  if (!publishing) return e
  if (!a.due) e.push('Set a due date.')
  if (a.type === 'quiz') {
    if (!a.questions.length) e.push('Add at least one question.')
    a.questions.forEach((q, i) => {
      if (!q.q.trim()) e.push(`Question ${i + 1} has no text.`)
      if (q.o.some(o => !o.trim())) e.push(`Question ${i + 1} has an empty option.`)
      if (q.a == null) e.push(`Question ${i + 1} needs a correct answer selected.`)
      if (q.m < 0) e.push(`Question ${i + 1}: marks must be 0 or more.`)
    })
  } else {
    if (a.instructions.trim().length < 20) e.push('Write a brief of at least 20 characters.')
    if (a.type !== 'exam') {
      if (!a.rubric.length) e.push('Add at least one rubric criterion.')
      a.rubric.forEach((c, i) => { if (!c.criterion.trim()) e.push(`Rubric criterion ${i + 1} has no name.`); if (!(c.max > 0)) e.push(`Rubric criterion ${i + 1} needs marks above zero.`) })
      const tot = a.rubric.reduce((s, c) => s + (+c.max || 0), 0)
      if (a.rubric.length && tot !== a.max_score) e.push(`Rubric marks add up to ${tot}, but the assessment is out of ${a.max_score}.`)
    }
  }
  return e
}

export default function AssessmentBuilder() {
  const [sp, setSp] = useSearchParams()
  const courses = useMyCourses()
  const list = useQuery({ queryKey: ['lect-assessments'], queryFn: () => get<any[]>('/api/lecturer/assessments') })
  const id = sp.get('id')
  if (courses.isLoading || list.isLoading) return <Loading />
  if (courses.error || list.error) return <ErrorBox error={courses.error || list.error} retry={() => { courses.refetch(); list.refetch() }} />
  if (!courses.data?.length) return <><PageHead no={17} title="Assessment builder" /><Empty icon="book" title="No courses assigned" /></>
  const code = Object.fromEntries(courses.data.map(c => [c.id, c.code]))
  return <>
    <PageHead no={17} title="Assessment builder" sub="Create quizzes and assignments with lecturer-approved scoring rules." />
    <div className="g g-12">
      <Card title="Your assessments" actions={<button className="btn sm pri" onClick={() => setSp({ id: 'new' })}><Icon n="plus" />New</button>}>
        {!list.data!.length ? <Empty icon="clip" title="No assessments yet" /> : <div className="list">{list.data!.map(a => <button key={a.id} className={`li ${a.id === id ? 'sel' : ''}`}
          style={{ textAlign: 'left', background: a.id === id ? 'var(--surface-2)' : 'none', border: 0, width: '100%', cursor: 'pointer', font: 'inherit', color: 'inherit' }} onClick={() => setSp({ id: a.id })}>
          <div className="ic"><Icon n={a.type === 'quiz' ? 'checkc' : a.type === 'exam' ? 'award' : 'clip'} /></div>
          <div className="bd"><div className="tt small">{a.title}</div><div className="ds">{code[a.course_id]} · {a.type} · due {fmtDate(a.due)} · {a.weight}%</div></div>
          <Badge kind={a.status === 'published' ? 'good' : 'warn'}>{a.status}</Badge></button>)}</div>}
      </Card>
      {id ? <BuilderLoader key={id} id={id} courses={courses.data} onSaved={nid => { list.refetch(); setSp({ id: nid }) }} onDeleted={() => { list.refetch(); setSp({}) }} />
        : <Card><Empty icon="edit" title="Choose an assessment to edit">Or create a new quiz or assignment.</Empty><div className="row" style={{ justifyContent: 'center' }}><button className="btn pri" onClick={() => setSp({ id: 'new' })}><Icon n="plus" />New assessment</button></div></Card>}
    </div>
  </>
}

function BuilderLoader({ id, courses, onSaved, onDeleted }: { id: string; courses: any[]; onSaved: (id: string) => void; onDeleted: () => void }) {
  const q = useQuery({ queryKey: ['lect-assessment', id], queryFn: () => get<A>(`/api/lecturer/assessments/${id}`), enabled: id !== 'new' })
  if (id === 'new') return <Builder initial={blank(courses[0].id, 'quiz')} courses={courses} onSaved={onSaved} onDeleted={onDeleted} />
  if (q.isLoading) return <Loading />
  if (q.error) return <ErrorBox error={q.error} retry={() => q.refetch()} />
  const a = q.data!
  return <Builder initial={{ ...a, settings: { ...DEF_SETTINGS, ...(a.settings || {}) }, questions: (a.questions || []).map((x: any) => ({ ex: '', m: 1, ...x, o: [...(x.o || []), '', '', '', ''].slice(0, Math.max(4, (x.o || []).length)) })) }}
    courses={courses} onSaved={onSaved} onDeleted={onDeleted} />
}

function Builder({ initial, courses, onSaved, onDeleted }: { initial: A; courses: any[]; onSaved: (id: string) => void; onDeleted: () => void }) {
  const qc = useQueryClient(); const toast = useToast()
  const [a, setA] = useState<A>(initial); const [errs, setErrs] = useState<string[]>([]); const [preview, setPreview] = useState(false)
  const bank = useQuery({ queryKey: ['lect-bank', a.course_id], queryFn: () => get<any[]>(`/api/lecturer/assessments/bank?course_id=${a.course_id}`), enabled: a.type === 'quiz' })
  const save = useMutation({
    mutationFn: (status: string) => { const body = { ...a, status, title: a.title.trim() }; return a.id ? put<A>(`/api/lecturer/assessments/${a.id}`, body) : post<A>('/api/lecturer/assessments', body) },
    onSuccess: (r, status) => { setA(x => ({ ...x, id: r.id, status: r.status, submissions: r.submissions })); toast(status === 'published' ? 'Published — students will see it in Assignments & Quizzes' : 'Draft saved'); qc.invalidateQueries({ queryKey: ['lect-assessment', r.id] }); setErrs([]); onSaved(r.id!) },
    onError: (e: any) => setErrs([e.message]),
  })
  const remove = useMutation({ mutationFn: () => del(`/api/lecturer/assessments/${a.id}`), onSuccess: () => { toast('Assessment deleted'); onDeleted() }, onError: (e: any) => toast(e.message, true) })
  const set = (k: keyof A, v: any) => setA(x => ({ ...x, [k]: v }))
  const setS = (k: string, v: any) => setA(x => ({ ...x, settings: { ...x.settings, [k]: v } }))
  const setQ = (i: number, p: Partial<Q>) => setA(x => ({ ...x, questions: x.questions.map((q, k) => k === i ? { ...q, ...p } : q) }))
  const setC = (i: number, p: Partial<Cr>) => setA(x => ({ ...x, rubric: x.rubric.map((c, k) => k === i ? { ...c, ...p } : c) }))
  const go = (status: string) => { const e = check(a, status === 'published'); setErrs(e); if (!e.length) save.mutate(status) }
  const locked = !!a.submissions
  const qTotal = a.questions.reduce((s, q) => s + (+q.m || 0), 0)
  const rTotal = a.rubric.reduce((s, c) => s + (+c.max || 0), 0)
  const isQuiz = a.type === 'quiz'
  return <div className="stack">
    <div className="row"><Badge kind={a.status === 'published' ? 'good' : 'warn'} dot>{a.status === 'published' ? 'Published' : 'Draft'}</Badge>
      {locked && <span className="xs muted">{a.submissions} submission(s) — type and maximum score are locked.</span>}<span className="sp" />
      <button className="btn" onClick={() => setPreview(true)}><Icon n="eye" />Preview</button>
      <button className="btn" disabled={save.isPending} onClick={() => go(a.status === 'published' && a.submissions ? 'published' : 'draft')}><Icon n="save" />{a.status === 'published' && a.submissions ? 'Save changes' : 'Save draft'}</button>
      <button className="btn pri" disabled={save.isPending} onClick={() => go('published')}><Icon n="upload" />{a.status === 'published' ? 'Update published' : 'Publish'}</button></div>
    {!a.id && <Tabs tabs={[['quiz', 'Quiz'], ['assignment', 'Assignment'], ['exam', 'Exam']]} value={a.type} onChange={t => setA(blank(a.course_id, t))} />}
    <ErrList errors={errs} />
    <Card>
      <div className="g g3">
        <div style={{ gridColumn: 'span 2' }}><Field label="Title" htmlFor="ab-t"><input className={`inp ${errs.length && a.title.trim().length < 3 ? 'bad' : ''}`} id="ab-t" maxLength={300} value={a.title} placeholder={isQuiz ? 'e.g. Quiz 3: Evaluating models' : 'e.g. Assignment 2: Responsible AI case study'} onChange={e => set('title', e.target.value)} /></Field></div>
        <Field label="Course" htmlFor="ab-c"><select className="inp" id="ab-c" value={a.course_id} disabled={!!a.id} onChange={e => set('course_id', e.target.value)}>{courses.map(c => <option key={c.id} value={c.id}>{c.code}</option>)}</select></Field>
        <Field label="Due" htmlFor="ab-due"><input className="inp" type="datetime-local" id="ab-due" value={toLocalInput(a.due)} onChange={e => set('due', fromLocalInput(e.target.value))} /></Field>
        <Field label="Weight (% of course)" htmlFor="ab-w"><input className="inp" type="number" min={0} max={100} id="ab-w" value={a.weight} onChange={e => set('weight', +e.target.value)} /></Field>
        <Field label="Maximum score" htmlFor="ab-max"><input className="inp" type="number" min={1} max={1000} id="ab-max" disabled={locked} value={a.max_score} onChange={e => set('max_score', +e.target.value)} /></Field>
        <div style={{ gridColumn: '1/-1' }}><Field label={isQuiz ? 'Instructions' : 'Brief'} htmlFor="ab-ins"><textarea className="inp" id="ab-ins" rows={isQuiz ? 2 : 4} maxLength={8000} value={a.instructions} onChange={e => set('instructions', e.target.value)} /></Field></div>
      </div>
    </Card>
    <div className="g g-21">
      <div className="stack">
        {isQuiz ? <>
          {!a.questions.length && <Empty icon="checkc" title="No questions yet">Add a multiple-choice question or pick one from the question bank.</Empty>}
          {a.questions.map((q, i) => <Card key={i} title={`Question ${i + 1}`} actions={<div className="row" style={{ flexWrap: 'nowrap' }}>
            <label className="xs" htmlFor={`ab-m${i}`}>Marks</label><input className="inp" id={`ab-m${i}`} type="number" min={0} style={{ width: 70 }} value={q.m} onChange={e => setQ(i, { m: +e.target.value })} />
            <button className="iconbtn" aria-label={`Delete question ${i + 1}`} onClick={() => setA(x => ({ ...x, questions: x.questions.filter((_, k) => k !== i) }))}><Icon n="x" /></button></div>}>
            <textarea className={`inp ${errs.length && !q.q.trim() ? 'bad' : ''}`} rows={2} maxLength={1000} aria-label={`Question ${i + 1} text`} value={q.q} onChange={e => setQ(i, { q: e.target.value })} />
            <div className="col" style={{ marginTop: 10 }}>{q.o.map((o, k) => <label className="row" style={{ flexWrap: 'nowrap' }} key={k}>
              <input type="radio" name={`ab-a${i}`} checked={q.a === k} onChange={() => setQ(i, { a: k })} aria-label={`Mark option ${'ABCDEF'[k]} correct`} />
              <span className="k mono">{'ABCDEF'[k]}</span><input className={`inp ${errs.length && !o.trim() ? 'bad' : ''}`} value={o} maxLength={300} aria-label={`Option ${'ABCDEF'[k]}`} onChange={e => setQ(i, { o: q.o.map((x, z) => z === k ? e.target.value : x) })} /></label>)}
              <span className="xs muted">Select the radio button next to the correct answer.</span></div>
            <div style={{ marginTop: 8 }}><Field label="Explanation shown after the due date" htmlFor={`ab-ex${i}`}><input className="inp" id={`ab-ex${i}`} maxLength={1000} value={q.ex} onChange={e => setQ(i, { ex: e.target.value })} /></Field></div>
          </Card>)}
          <div className="row"><button className="btn" onClick={() => setA(x => ({ ...x, questions: [...x.questions, blankQ()] }))} disabled={a.questions.length >= 100}><Icon n="plus" />Multiple-choice question</button></div>
        </> : <Card title="Rubric" actions={<span className={`xs ${rTotal !== a.max_score ? 'muted' : ''}`}>{rTotal} / {a.max_score} marks allocated</span>}>
          {a.type === 'exam' && <p className="xs muted" style={{ marginTop: 0 }}>Optional for exams. Leave empty to enter a single overall mark.</p>}
          <div className="col">{a.rubric.map((c, i) => <div className="row" key={i} style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}>
            <div className="col" style={{ flex: 1, gap: 4 }}><input className="inp" value={c.criterion} maxLength={200} placeholder="Criterion, e.g. Method & reproducibility" aria-label={`Criterion ${i + 1}`} onChange={e => setC(i, { criterion: e.target.value })} />
              <input className="inp" value={c.desc} maxLength={600} placeholder="What a strong answer shows (optional)" aria-label={`Criterion ${i + 1} description`} onChange={e => setC(i, { desc: e.target.value })} /></div>
            <input className="inp num" type="number" min={0} style={{ width: 80 }} aria-label={`Criterion ${i + 1} marks`} value={c.max} onChange={e => setC(i, { max: +e.target.value })} />
            <button className="iconbtn" aria-label={`Remove criterion ${i + 1}`} onClick={() => setA(x => ({ ...x, rubric: x.rubric.filter((_, k) => k !== i) }))}><Icon n="x" /></button></div>)}</div>
          <button className="btn sm" style={{ marginTop: 8 }} disabled={a.rubric.length >= 20} onClick={() => setA(x => ({ ...x, rubric: [...x.rubric, { criterion: '', max: 10, desc: '' }] }))}><Icon n="plus" />Add criterion</button>
        </Card>}
      </div>
      <div className="stack">
        <Card title="Scoring rules">
          <dl className="kv"><dt>Total marks</dt><dd className="num">{isQuiz ? `${qTotal} (scaled to ${a.max_score})` : a.max_score}</dd><dt>Weight</dt><dd>{a.weight}% of course</dd></dl>
          <div className="col" style={{ marginTop: 10 }}>
            <Field label="Attempts" htmlFor="ab-att"><select className="inp" id="ab-att" value={a.settings.attempts} onChange={e => setS('attempts', +e.target.value)}>{[1, 2, 3].map(n => <option key={n} value={n}>{n}{n > 1 ? ' (highest counts)' : ''}</option>)}</select></Field>
            <Field label="Time limit (minutes)" htmlFor="ab-tl" hint="Leave blank for no limit."><input className="inp" id="ab-tl" type="number" min={1} max={600} value={a.settings.time_limit ?? ''} onChange={e => setS('time_limit', e.target.value ? +e.target.value : null)} /></Field>
            <Field label="Late submissions" htmlFor="ab-late"><select className="inp" id="ab-late" value={a.settings.late_policy} onChange={e => setS('late_policy', e.target.value)}><option value="accept">Accept, flag as late</option><option value="penalty">Accept with a penalty</option><option value="reject">Do not accept after the due date</option></select></Field>
            {a.settings.late_policy === 'penalty' && <Field label="Penalty (% of mark per day)" htmlFor="ab-pen"><input className="inp" id="ab-pen" type="number" min={0} max={100} value={a.settings.late_penalty} onChange={e => setS('late_penalty', +e.target.value)} /></Field>}
            {!isQuiz && <Field label="Accepted files" htmlFor="ab-files"><input className="inp" id="ab-files" maxLength={100} value={a.settings.accepted_files} onChange={e => setS('accepted_files', e.target.value)} /></Field>}
            {isQuiz && <><Switch id="ab-show" checked={a.settings.show_answers} onChange={v => setS('show_answers', v)} label="Show correct answers after the due date" />
              <Switch id="ab-shuf" checked={a.settings.shuffle} onChange={v => setS('shuffle', v)} label="Shuffle options" /></>}
            <Switch id="ab-acc" checked={a.settings.accommodations} onChange={v => setS('accommodations', v)} label="Extra time for registered accommodations" />
          </div>
          <p className="xs muted" style={{ marginTop: 8 }}>{isQuiz ? 'Multiple-choice answers are scored automatically.' : 'Written work is marked by the lecturer against this rubric. AI may suggest feedback wording, never the mark.'}</p>
        </Card>
        {isQuiz && <Card title="Question bank" actions={<span className="xs muted">{courses.find(c => c.id === a.course_id)?.code}</span>}>
          {bank.isLoading ? <Loading /> : !(bank.data || []).length ? <Empty title="No saved questions yet" /> :
            <div className="list">{bank.data!.filter(b => !a.questions.some(q => q.q === b.q)).slice(0, 12).map((b, i) => <div className="li" key={i}><div className="bd small">{b.q}<div className="xs muted">{b.from}</div></div>
              <button className="btn sm" onClick={() => { setA(x => ({ ...x, questions: [...x.questions, { q: b.q, o: [...b.o], a: b.a, ex: b.ex || '', m: b.m || 1 }] })); toast('Added from question bank') }}><Icon n="plus" />Add</button></div>)}</div>}
        </Card>}
        {a.id && !a.submissions && <button className="btn ghost" disabled={remove.isPending} onClick={() => confirm('Delete this assessment?') && remove.mutate()}><Icon n="x" />Delete assessment</button>}
      </div>
    </div>
    {preview && <Modal wide title={`Student preview · ${a.title || 'Untitled'}`} onClose={() => setPreview(false)}>
      <p className="small muted">{a.instructions || 'No instructions.'}</p>
      {isQuiz ? a.questions.map((q, i) => <div className="card flat" key={i} style={{ marginBottom: 8 }}><b className="small">{i + 1}. {q.q || '(no text)'}</b> <span className="xs muted">{q.m} mark{q.m === 1 ? '' : 's'}</span>
        <div className="col" style={{ marginTop: 8 }}>{q.o.map((o, k) => <div className="qopt" key={k}><span className="k">{'ABCDEF'[k]}</span>{o}</div>)}</div></div>)
        : <div className="card flat"><b className="small">Rubric</b><ul className="small">{a.rubric.map((c, i) => <li key={i}>{c.criterion || '(unnamed)'} — {c.max} marks{c.desc ? `: ${c.desc}` : ''}</li>)}</ul><p className="xs muted">Accepted files: {a.settings.accepted_files}</p></div>}
    </Modal>}
  </div>
}
