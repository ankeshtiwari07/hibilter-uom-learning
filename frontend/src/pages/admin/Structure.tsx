import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Icon } from '../../components/Icon'
import { AiTag, Badge, Card, Empty, ErrorBox, Field, Loading, Modal, Note, PageHead, useToast } from '../../components/ui'
import { del, get, patch, post } from '../../lib/api'
import { fmtDate } from '../../lib/format'
import { InlineErr, Sel, Term, useMeta } from './shared'

type CourseRow = { id: string; code: string; title: string; faculty_id: string; programme_id: string | null; lecturer_id: string | null; lecturer: string | null; term: string; credits: number; status: string; vf_enabled: boolean; enrolled: number }
type Tree = { faculties: { id: string; name: string; short: string; programmes: { id: string; name: string; level: string; years: number; students: number; courses: CourseRow[] }[]; unassigned: CourseRow[] }[] }
type Detail = CourseRow & { faculty: string; programme: string | null; description: string; digital_lecturer: string | null; modules: { id: string; title: string; items: number }[]; vf_lessons: number; enrolled_sample: string[] }

const LEVELS = ['Undergraduate', 'Postgraduate', 'Short course', 'Doctoral', 'Diploma']
const STATUS_KIND: Record<string, string> = { published: 'good', draft: 'info', archived: 'out' }

export default function Structure() {
  const qc = useQueryClient(); const toast = useToast(); const meta = useMeta()
  const tree = useQuery({ queryKey: ['admin-structure'], queryFn: () => get<Tree>('/api/admin/structure') })
  const [sel, setSel] = useState<string>('')
  const [showArchived, setShowArchived] = useState(false)
  const [modal, setModal] = useState<null | { kind: 'faculty' | 'programme' | 'course' | 'term'; edit?: any }>(null)
  const firstCourse = tree.data?.faculties.flatMap(f => f.programmes.flatMap(p => p.courses))[0]?.id
  useEffect(() => { if (!sel && firstCourse) setSel(firstCourse) }, [firstCourse, sel])
  const refresh = () => { qc.invalidateQueries({ queryKey: ['admin-structure'] }); qc.invalidateQueries({ queryKey: ['admin-course'] }); qc.invalidateQueries({ queryKey: ['admin-meta'] }); qc.invalidateQueries({ queryKey: ['admin-terms'] }) }
  const vis = (c: CourseRow) => showArchived || c.status !== 'archived'
  return <>
    <PageHead no={22} title="Academic structure" sub="Faculties and centres (public names from uom.ac.mu), with demo programmes, courses, lecturer assignments, enrolments and academic terms."
      actions={<><button className="btn" onClick={() => setModal({ kind: 'faculty' })}><Icon n="bldg" />Add faculty</button><button className="btn" onClick={() => setModal({ kind: 'programme' })}><Icon n="plus" />Add programme</button><button className="btn pri" onClick={() => setModal({ kind: 'course' })}><Icon n="book" />Add course</button></>} />
    <Note kind="gold">Faculty and centre names are the University’s published names. Programmes, courses (HB- codes), modules and enrolments are <b>invented demo data</b>.</Note>
    {tree.isLoading ? <Loading label="Loading structure…" /> : tree.error ? <ErrorBox error={tree.error} retry={() => tree.refetch()} /> : <>
      <div className="g g-12" style={{ marginTop: 16 }}>
        <Card title="Structure" actions={<label className="chk xs"><input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} /> Show archived</label>}>
          <div className="col" style={{ gap: 4 }}>{tree.data!.faculties.map(f => {
            const courses = [...f.programmes.flatMap(p => p.courses), ...f.unassigned]
            return <details className="spec" key={f.id} open={courses.some(c => c.id === sel)}>
              <summary><Icon n="bldg" /><b className="small">{f.name}</b><span className="xs muted">{f.programmes.length} prog.</span>
                <button className="btn sm ghost" aria-label={`Edit ${f.short}`} onClick={e => { e.preventDefault(); setModal({ kind: 'faculty', edit: f }) }}><Icon n="edit" /></button></summary>
              <div style={{ padding: '6px 10px 10px 18px' }}>
                {!f.programmes.length && <span className="xs muted">No programmes yet. <button className="link-btn" onClick={() => setModal({ kind: 'programme', edit: { faculty_id: f.id } })}>Add one</button></span>}
                {f.programmes.map(p => <div key={p.id} style={{ marginTop: 8 }}>
                  <div className="row sb" style={{ flexWrap: 'nowrap' }}><div className="small" style={{ fontWeight: 600 }}>{p.name}<div className="xs muted" style={{ fontWeight: 400 }}>{p.level} · {p.years ? `${p.years} yrs` : 'short'} · {p.students} learners</div></div>
                    <button className="btn sm ghost" aria-label={`Edit ${p.name}`} onClick={() => setModal({ kind: 'programme', edit: { ...p, faculty_id: f.id } })}><Icon n="edit" /></button></div>
                  {p.courses.filter(vis).map(c => <button key={c.id} className="btn sm ghost" onClick={() => setSel(c.id)} aria-pressed={c.id === sel}
                    style={{ display: 'flex', width: '100%', justifyContent: 'flex-start', whiteSpace: 'normal', textAlign: 'left', background: c.id === sel ? 'var(--teal-soft)' : undefined, opacity: c.status === 'archived' ? .6 : 1 }}>
                    <Icon n="book" />{c.code} {c.title}{c.status !== 'published' && <Badge kind={STATUS_KIND[c.status]}>{c.status}</Badge>}</button>)}
                  {!p.courses.filter(vis).length && <span className="xs muted">No courses</span>}
                </div>)}
                {f.unassigned.filter(vis).length > 0 && <div style={{ marginTop: 8 }}><div className="small muted" style={{ fontWeight: 600 }}>Not linked to a programme</div>
                  {f.unassigned.filter(vis).map(c => <button key={c.id} className="btn sm ghost" onClick={() => setSel(c.id)} aria-pressed={c.id === sel}
                    style={{ display: 'flex', width: '100%', justifyContent: 'flex-start', whiteSpace: 'normal', textAlign: 'left', background: c.id === sel ? 'var(--teal-soft)' : undefined }}>
                    <Icon n="book" />{c.code} {c.title}{c.status !== 'published' && <Badge kind={STATUS_KIND[c.status]}>{c.status}</Badge>}</button>)}</div>}
              </div></details>
          })}</div>
        </Card>
        {sel ? <CourseDetail id={sel} onEdit={c => setModal({ kind: 'course', edit: c })} onChanged={refresh} /> : <Empty icon="book" title="Choose a course">Select a course in the tree to see its details.</Empty>}
      </div>
      <div style={{ marginTop: 16 }} />
      <Terms onAdd={() => setModal({ kind: 'term' })} onEdit={t => setModal({ kind: 'term', edit: t })} onChanged={refresh} />
    </>}
    {modal?.kind === 'faculty' && <FacultyModal edit={modal.edit} onClose={() => setModal(null)} onDone={m => { toast(m); refresh(); setModal(null) }} />}
    {modal?.kind === 'programme' && meta.data && <ProgrammeModal edit={modal.edit} meta={meta.data} onClose={() => setModal(null)} onDone={m => { toast(m); refresh(); setModal(null) }} />}
    {modal?.kind === 'course' && meta.data && <CourseModal edit={modal.edit} meta={meta.data} onClose={() => setModal(null)} onDone={(m, id) => { toast(m); refresh(); if (id) setSel(id); setModal(null) }} />}
    {modal?.kind === 'term' && <TermModal edit={modal.edit} onClose={() => setModal(null)} onDone={m => { toast(m); refresh(); setModal(null) }} />}
  </>
}

function CourseDetail({ id, onEdit, onChanged }: { id: string; onEdit: (c: Detail) => void; onChanged: () => void }) {
  const toast = useToast(); const meta = useMeta()
  const q = useQuery({ queryKey: ['admin-course', id], queryFn: () => get<Detail>(`/api/admin/courses/${id}`) })
  const [lec, setLec] = useState('')
  const [confirm, setConfirm] = useState<null | 'archived' | 'published'>(null)
  useEffect(() => { setLec(q.data?.lecturer_id || '') }, [q.data?.lecturer_id])
  const assign = useMutation({ mutationFn: () => patch(`/api/admin/courses/${id}`, { lecturer_id: lec || null }),
    onSuccess: () => { toast(lec ? `${meta.data?.staff.find(s => s.id === lec)?.name} assigned to ${q.data?.code}` : 'Lecturer unassigned'); onChanged() }, onError: (e: any) => toast(e.message, true) })
  const status = useMutation({ mutationFn: (s: string) => patch(`/api/admin/courses/${id}`, { status: s }),
    onSuccess: (_, s) => { toast(s === 'archived' ? 'Course archived' : 'Course restored'); setConfirm(null); onChanged() }, onError: (e: any) => toast(e.message, true) })
  if (q.isLoading) return <Card><Loading /></Card>
  if (q.error) return <ErrorBox error={q.error} retry={() => q.refetch()} />
  const c = q.data!
  const lecturers = (meta.data?.staff || []).filter(s => s.role === 'lecturer' && s.status === 'active')
  return <Card title={`${c.code} · ${c.title}`} actions={<div className="row" style={{ gap: 6 }}><Badge kind={STATUS_KIND[c.status]}>{c.status === 'published' ? 'Active' : c.status}</Badge><button className="btn sm" onClick={() => onEdit(c)}><Icon n="edit" />Edit</button></div>}>
    <dl className="kv"><dt>Faculty</dt><dd>{c.faculty}</dd><dt>Programme</dt><dd>{c.programme || '—'}</dd><dt>Semester</dt><dd>{c.term}</dd><dt>Credits</dt><dd>{c.credits || '—'}</dd><dt>Enrolled</dt><dd>{c.enrolled} learners</dd>{c.description && <><dt>Description</dt><dd className="small">{c.description}</dd></>}</dl>
    <div className="g g2" style={{ marginTop: 14 }}>
      <div><div className="eyebrow">Lecturer assignment</div>
        <div className="row" style={{ marginTop: 6, flexWrap: 'nowrap' }}>
          <select className="inp" aria-label="Lecturer" value={lec} onChange={e => setLec(e.target.value)}><option value="">Unassigned</option>{lecturers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
          <button className="btn sm pri" disabled={assign.isPending || lec === (c.lecturer_id || '')} onClick={() => assign.mutate()}>{assign.isPending ? 'Saving…' : 'Assign'}</button></div></div>
      <div><div className="eyebrow">Digital lecturer</div><div className="row" style={{ marginTop: 6 }}>{c.vf_enabled ? <><AiTag label={c.digital_lecturer ? `Virtual faculty · ${c.digital_lecturer}` : 'Virtual faculty'} /><span className="xs muted">{c.vf_lessons} lesson(s)</span></> : <span className="small muted">Not enabled — lecturers configure it in their course.</span>}</div></div>
    </div>
    <div className="eyebrow" style={{ marginTop: 14 }}>Modules</div>
    {c.modules.length ? <div className="list">{c.modules.map(m => <div className="li" key={m.id}><div className="ic"><Icon n="layers" /></div><div className="bd"><div className="tt small">{m.title}</div><div className="ds">{m.items} items</div></div></div>)}</div> : <p className="small muted">No modules yet — the course lecturer builds them.</p>}
    <div className="eyebrow" style={{ marginTop: 14 }}>Enrolment relationships</div>
    <div className="row small">{c.enrolled_sample.map(n => <span key={n} className="b out">{n}</span>)}{c.enrolled > c.enrolled_sample.length && <span className="xs muted">+ {c.enrolled - c.enrolled_sample.length} more</span>}{!c.enrolled && <span className="small muted">No learners enrolled.</span>}</div>
    <div className="row" style={{ marginTop: 16 }}>
      {c.status === 'archived' ? <button className="btn" onClick={() => setConfirm('published')}><Icon n="refresh" />Restore course</button> : <button className="btn danger" onClick={() => setConfirm('archived')}><Icon n="x" />Archive course</button>}
    </div>
    {confirm && <Modal title={confirm === 'archived' ? `Archive ${c.code}?` : `Restore ${c.code}?`} onClose={() => setConfirm(null)}
      footer={<><button className="btn" onClick={() => setConfirm(null)}>Cancel</button><button className={`btn ${confirm === 'archived' ? 'danger' : 'pri'}`} disabled={status.isPending} onClick={() => status.mutate(confirm)}>{status.isPending ? 'Saving…' : confirm === 'archived' ? 'Archive' : 'Restore'}</button></>}>
      <p className="small">{confirm === 'archived' ? 'Archived courses are hidden from analytics and new enrolments. Grades, submissions and enrolment history are kept. You can restore it later.' : 'The course becomes active again and appears in analytics.'} This is written to the audit log.</p>
    </Modal>}
  </Card>
}

function Terms({ onAdd, onEdit, onChanged }: { onAdd: () => void; onEdit: (t: Term) => void; onChanged: () => void }) {
  const toast = useToast()
  const q = useQuery({ queryKey: ['admin-terms'], queryFn: () => get<Term[]>('/api/admin/terms') })
  const cur = useMutation({ mutationFn: (id: string) => post(`/api/admin/terms/${id}/current`), onSuccess: () => { toast('Current term updated'); onChanged() }, onError: (e: any) => toast(e.message, true) })
  const rm = useMutation({ mutationFn: (id: string) => del(`/api/admin/terms/${id}`), onSuccess: () => { toast('Term deleted'); onChanged() }, onError: (e: any) => toast(e.message, true) })
  return <Card title="Academic terms" className="" actions={<button className="btn sm" onClick={onAdd}><Icon n="plus" />Add term</button>}>
    {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} retry={() => q.refetch()} /> : !q.data!.length ? <Empty icon="cal" title="No terms defined" /> :
      <div className="tbl-wrap"><table className="t"><thead><tr><th>Term</th><th>Starts</th><th>Ends</th><th>Status</th><th></th></tr></thead>
        <tbody>{q.data!.map(t => <tr key={t.id}><td><b>{t.name}</b></td><td className="small">{new Date(t.start).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</td><td className="small">{new Date(t.end).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</td>
          <td>{t.current ? <Badge kind="good" dot>Current</Badge> : <Badge kind="out">{new Date(t.start) > new Date() ? 'Upcoming' : 'Past'}</Badge>}</td>
          <td><div className="row" style={{ flexWrap: 'nowrap', gap: 6 }}>
            {!t.current && <button className="btn sm" disabled={cur.isPending} onClick={() => cur.mutate(t.id)}>Set current</button>}
            <button className="btn sm ghost" onClick={() => onEdit(t)} aria-label={`Edit ${t.name}`}><Icon n="edit" /></button>
            {!t.current && <button className="btn sm ghost" disabled={rm.isPending} onClick={() => { if (confirm(`Delete ${t.name}?`)) rm.mutate(t.id) }} aria-label={`Delete ${t.name}`}><Icon n="x" /></button>}
          </div></td></tr>)}</tbody></table></div>}
    <p className="xs muted" style={{ marginTop: 8 }}>The current term sets the reporting window for dashboards. Terms can’t overlap. Updated {fmtDate(new Date().toISOString())}.</p>
  </Card>
}

/* ---------- modals ---------- */
function useSave(onDone: (m: string, id?: string) => void, msg: string) {
  const [err, setErr] = useState<string | null>(null)
  const m = useMutation({ mutationFn: (f: () => Promise<any>) => f(), onSuccess: (r: any) => onDone(msg, r?.id), onError: (e: any) => setErr(e.message) })
  return { err, setErr, run: m.mutate, pending: m.isPending }
}

function FacultyModal({ edit, onClose, onDone }: { edit?: any; onClose: () => void; onDone: (m: string) => void }) {
  const [f, setF] = useState({ id: edit?.id || '', name: edit?.name || '', short: edit?.short || '' })
  const s = useSave(onDone, edit ? 'Faculty updated' : 'Faculty added')
  const submit = () => {
    if (!edit && !/^[a-z0-9][a-z0-9-]{1,15}$/.test(f.id)) return s.setErr('Faculty ID must be 2–16 lowercase letters, digits or hyphens.')
    if (f.name.trim().length < 3) return s.setErr('Enter the faculty name.'); if (f.short.trim().length < 2) return s.setErr('Enter a short name.')
    s.setErr(null); s.run(() => edit ? patch(`/api/admin/faculties/${edit.id}`, f) : post('/api/admin/faculties', f))
  }
  return <Modal title={edit ? `Edit ${edit.short}` : 'Add faculty or centre'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn pri" disabled={s.pending} onClick={submit}>{s.pending ? 'Saving…' : edit ? 'Save' : 'Add'}</button></>}>
    <div className="col">
      {!edit && <Field label="ID" htmlFor="fa-id" hint="Short, lowercase, permanent (e.g. ssh)"><input className="inp" id="fa-id" value={f.id} onChange={e => setF({ ...f, id: e.target.value.toLowerCase() })} maxLength={16} /></Field>}
      <Field label="Full name" htmlFor="fa-n"><input className="inp" id="fa-n" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} maxLength={200} /></Field>
      <Field label="Short name" htmlFor="fa-s"><input className="inp" id="fa-s" value={f.short} onChange={e => setF({ ...f, short: e.target.value })} maxLength={64} /></Field>
      <InlineErr msg={s.err} />
    </div></Modal>
}

function ProgrammeModal({ edit, meta, onClose, onDone }: { edit?: any; meta: any; onClose: () => void; onDone: (m: string) => void }) {
  const isEdit = !!edit?.id
  const [f, setF] = useState({ faculty_id: edit?.faculty_id || meta.faculties[0]?.id || '', name: edit?.name || '', level: edit?.level || 'Undergraduate', years: edit?.years ?? 3 })
  const s = useSave(onDone, isEdit ? 'Programme updated' : 'Programme added')
  const rm = useSave(onDone, 'Programme deleted')
  const submit = () => {
    if (f.name.trim().length < 3) return s.setErr('Enter the programme name (e.g. MSc Applied Artificial Intelligence).')
    s.setErr(null); s.run(() => isEdit ? patch(`/api/admin/programmes/${edit.id}`, f) : post('/api/admin/programmes', f))
  }
  return <Modal title={isEdit ? 'Edit programme' : 'Add programme'} onClose={onClose} footer={<>{isEdit && <button className="btn danger" disabled={rm.pending} onClick={() => rm.run(() => del(`/api/admin/programmes/${edit.id}`))} style={{ marginRight: 'auto' }}>Delete</button>}<button className="btn" onClick={onClose}>Cancel</button><button className="btn pri" disabled={s.pending} onClick={submit}>{s.pending ? 'Saving…' : isEdit ? 'Save' : 'Add'}</button></>}>
    <div className="col">
      <Sel id="pr-f" label="Faculty" value={f.faculty_id} onChange={v => setF({ ...f, faculty_id: v })} options={meta.faculties.map((x: any) => [x.id, x.name])} />
      <Field label="Programme name" htmlFor="pr-n"><input className="inp" id="pr-n" value={f.name} placeholder="e.g. MSc Applied Artificial Intelligence" onChange={e => setF({ ...f, name: e.target.value })} maxLength={200} /></Field>
      <div className="g g2"><Sel id="pr-l" label="Level" value={f.level} onChange={v => setF({ ...f, level: v })} options={LEVELS.map(l => [l, l])} />
        <Field label="Duration (years)" htmlFor="pr-y" hint="0 for short courses"><input className="inp" id="pr-y" type="number" min={0} max={8} value={f.years} onChange={e => setF({ ...f, years: Number(e.target.value) })} /></Field></div>
      <InlineErr msg={s.err || rm.err} />
    </div></Modal>
}

function CourseModal({ edit, meta, onClose, onDone }: { edit?: Detail; meta: any; onClose: () => void; onDone: (m: string, id?: string) => void }) {
  const [f, setF] = useState({ code: edit?.code || 'HB-', title: edit?.title || '', faculty_id: edit?.faculty_id || meta.faculties[0]?.id || '', programme_id: edit?.programme_id || '', lecturer_id: edit?.lecturer_id || '', term: edit?.term || meta.course_terms[0] || 'S1 2026/27', credits: edit?.credits ?? 3, description: edit?.description || '', status: edit?.status || 'draft' })
  const [errs, setErrs] = useState<Record<string, string>>({})
  const s = useSave(onDone, edit ? 'Course updated' : 'Course created')
  const progs = meta.programmes.filter((p: any) => p.faculty_id === f.faculty_id)
  const lecturers = meta.staff.filter((x: any) => x.role === 'lecturer' && x.status === 'active')
  const submit = () => {
    const e: Record<string, string> = {}
    const code = f.code.trim().toUpperCase()
    if (!/^[A-Z]{2,5}-[A-Z]{2,4}\d{3}[A-Z]?$/.test(code)) e.code = 'Use a code like HB-AI101.'
    else if (meta.courses.some((c: any) => c.code.toUpperCase() === code && c.id !== edit?.id)) e.code = `${code} is already in use.`
    if (f.title.trim().length < 3) e.title = 'Enter the course title.'
    if (f.credits < 0 || f.credits > 60) e.credits = 'Credits must be between 0 and 60.'
    setErrs(e); if (Object.keys(e).length) return
    const body = { ...f, code, programme_id: f.programme_id || null, lecturer_id: f.lecturer_id || null }
    s.setErr(null); s.run(() => edit ? patch(`/api/admin/courses/${edit.id}`, body) : post('/api/admin/courses', body))
  }
  return <Modal wide title={edit ? `Edit ${edit.code}` : 'Add course'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn pri" disabled={s.pending} onClick={submit}>{s.pending ? 'Saving…' : edit ? 'Save changes' : 'Create course'}</button></>}>
    <div className="g g2">
      <Field label="Course code" htmlFor="co-c" error={errs.code} hint="Unique, e.g. HB-AI101"><input className={`inp ${errs.code ? 'bad' : ''}`} id="co-c" value={f.code} onChange={e => setF({ ...f, code: e.target.value.toUpperCase() })} maxLength={32} /></Field>
      <Field label="Title" htmlFor="co-t" error={errs.title}><input className={`inp ${errs.title ? 'bad' : ''}`} id="co-t" value={f.title} onChange={e => setF({ ...f, title: e.target.value })} maxLength={200} /></Field>
      <Sel id="co-f" label="Faculty" value={f.faculty_id} onChange={v => setF({ ...f, faculty_id: v, programme_id: '' })} options={meta.faculties.map((x: any) => [x.id, x.short])} />
      <Sel id="co-p" label="Programme" value={f.programme_id} onChange={v => setF({ ...f, programme_id: v })} options={[['', 'Not linked to a programme'], ...progs.map((p: any) => [p.id, p.name])]} />
      <Sel id="co-l" label="Lecturer" value={f.lecturer_id} onChange={v => setF({ ...f, lecturer_id: v })} options={[['', 'Unassigned'], ...lecturers.map((x: any) => [x.id, x.name])]} />
      <Field label="Semester" htmlFor="co-s" hint="e.g. S1 2026/27 or Rolling"><input className="inp" id="co-s" list="co-terms" value={f.term} onChange={e => setF({ ...f, term: e.target.value })} maxLength={32} /><datalist id="co-terms">{meta.course_terms.map((t: string) => <option key={t} value={t} />)}</datalist></Field>
      <Field label="Credits" htmlFor="co-cr" error={errs.credits}><input className="inp" id="co-cr" type="number" min={0} max={60} value={f.credits} onChange={e => setF({ ...f, credits: Number(e.target.value) })} /></Field>
      <Sel id="co-st" label="Status" value={f.status} onChange={v => setF({ ...f, status: v })} options={[['draft', 'Draft (hidden from learners)'], ['published', 'Active'], ['archived', 'Archived']]} />
      <div style={{ gridColumn: '1/-1' }}><Field label="Description" htmlFor="co-d"><textarea className="inp" id="co-d" rows={3} value={f.description} onChange={e => setF({ ...f, description: e.target.value })} maxLength={4000} /></Field></div>
    </div>
    <div style={{ marginTop: 8 }}><InlineErr msg={s.err} /></div>
  </Modal>
}

function TermModal({ edit, onClose, onDone }: { edit?: Term; onClose: () => void; onDone: (m: string) => void }) {
  const [f, setF] = useState({ name: edit?.name || '', start: edit?.start || '', end: edit?.end || '' })
  const s = useSave(onDone, edit ? 'Term updated' : 'Term added')
  const submit = () => {
    if (f.name.trim().length < 3) return s.setErr('Name the term (e.g. Semester 2 2026/27).')
    if (!f.start || !f.end) return s.setErr('Choose start and end dates.')
    if (f.end <= f.start) return s.setErr('The term must end after it starts.')
    s.setErr(null); s.run(() => edit ? patch(`/api/admin/terms/${edit.id}`, f) : post('/api/admin/terms', f))
  }
  return <Modal title={edit ? `Edit ${edit.name}` : 'Add academic term'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn pri" disabled={s.pending} onClick={submit}>{s.pending ? 'Saving…' : edit ? 'Save' : 'Add term'}</button></>}>
    <div className="col">
      <Field label="Name" htmlFor="te-n"><input className="inp" id="te-n" value={f.name} placeholder="Semester 2 2026/27" onChange={e => setF({ ...f, name: e.target.value })} maxLength={100} /></Field>
      <div className="g g2"><Field label="Starts" htmlFor="te-s"><input className="inp" id="te-s" type="date" value={f.start} onChange={e => setF({ ...f, start: e.target.value })} /></Field>
        <Field label="Ends" htmlFor="te-e"><input className="inp" id="te-e" type="date" value={f.end} onChange={e => setF({ ...f, end: e.target.value })} /></Field></div>
      <InlineErr msg={s.err} />
    </div></Modal>
}
