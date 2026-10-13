import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Icon } from '../../components/Icon'
import { Badge, Bar, Card, Empty, ErrorBox, Field, Loading, Modal, PageHead, Switch, Tabs, useToast } from '../../components/ui'
import { get, patch, put } from '../../lib/api'
import { rel } from '../../lib/format'
import { InlineErr, ListEditor, useMyCourses } from './shared'

type Item = { id: string; type: string; title: string; dur: number; vf?: boolean; lesson_id?: string; assessment_id?: string }
type Mod = { id?: string; key: string; title: string; published: boolean; items: Item[] }
const TYPE_IC: Record<string, string> = { virtual: 'cap', video: 'play', reading: 'book', quiz: 'checkc', assignment: 'clip' }
const TYPES: [string, string][] = [['virtual', 'Virtual faculty'], ['video', 'Video'], ['reading', 'Reading'], ['quiz', 'Quiz'], ['assignment', 'Assignment']]
let seq = 0; const key = () => `k${++seq}`

export default function Courses() {
  const [sp, setSp] = useSearchParams()
  const courses = useMyCourses()
  const cid = sp.get('course') || courses.data?.[0]?.id || ''
  const [tab, setTab] = useState('content')
  if (courses.isLoading) return <Loading />
  if (courses.error) return <ErrorBox error={courses.error} retry={() => courses.refetch()} />
  if (!courses.data?.length) return <><PageHead no={15} title="Course management" /><Empty icon="book" title="No courses assigned">You aren’t the lecturer of any course this semester.</Empty></>
  return <>
    <PageHead no={15} title="Course management" sub="Edit description, outcomes, modules and materials. Structural changes stay in draft until you publish." />
    <div className="row" role="tablist" aria-label="Your courses">{courses.data.map(c => <button key={c.id} className={`b ${c.id === cid ? 'teal' : 'out'}`} style={{ cursor: 'pointer', border: 0 }}
      aria-pressed={c.id === cid} onClick={() => setSp({ course: c.id })}>{c.code} · {c.title}</button>)}</div>
    <Tabs tabs={[['content', 'Details & modules'], ['roster', 'Students']]} value={tab} onChange={setTab} />
    {cid && (tab === 'content' ? <CourseEditor key={cid} cid={cid} /> : <Roster cid={cid} />)}
  </>
}

function CourseEditor({ cid }: { cid: string }) {
  const qc = useQueryClient(); const toast = useToast()
  const q = useQuery({ queryKey: ['lect-course', cid], queryFn: () => get<any>(`/api/lecturer/courses/${cid}`) })
  const [form, setForm] = useState<any>(null); const [mods, setMods] = useState<Mod[]>([]); const [dirty, setDirty] = useState(false)
  const [err, setErr] = useState<string | null>(null); const [drag, setDrag] = useState<number | null>(null)
  const [itemEdit, setItemEdit] = useState<{ m: number; i: number | null } | null>(null)
  useEffect(() => {
    if (!q.data) return
    const c = q.data
    setForm({ title: c.title, description: c.description || '', status: c.status, vf_enabled: c.vf_enabled, outcomes: c.outcomes || [] })
    setMods(c.modules.map((m: any) => ({ id: m.id, key: m.id, title: m.title.replace(/^Module \d+\s*·\s*/, ''), published: !(c.draft_modules || []).includes(m.id), items: m.items })))
    setDirty(false)
  }, [q.data])
  const saveDetails = useMutation({
    mutationFn: () => patch(`/api/lecturer/courses/${cid}`, { ...form, outcomes: form.outcomes.filter((o: string) => o.trim()) }),
    onSuccess: () => { toast('Course settings saved'); qc.invalidateQueries({ queryKey: ['lect-course', cid] }); qc.invalidateQueries({ queryKey: ['lect-courses'] }) },
    onError: (e: any) => toast(e.message, true),
  })
  const publish = useMutation({
    mutationFn: () => put(`/api/lecturer/courses/${cid}/modules`, { modules: mods.map(m => ({ id: m.id, title: m.title, published: m.published, items: m.items })) }),
    onSuccess: () => { toast(`Changes published to ${q.data.code}`); setDirty(false); qc.invalidateQueries({ queryKey: ['lect-course', cid] }) },
    onError: (e: any) => toast(e.message, true),
  })
  if (q.isLoading || !form) return <Loading />
  if (q.error) return <ErrorBox error={q.error} retry={() => q.refetch()} />
  const c = q.data
  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }))
  const upd = (fn: (m: Mod[]) => Mod[]) => { setMods(fn); setDirty(true) }
  const move = (from: number, to: number) => upd(ms => { const x = [...ms]; const [m] = x.splice(from, 1); x.splice(to, 0, m); return x })
  const moveItem = (mi: number, from: number, to: number) => upd(ms => ms.map((m, k) => { if (k !== mi) return m; const it = [...m.items]; const [x] = it.splice(from, 1); it.splice(to, 0, x); return { ...m, items: it } }))
  const submitDetails = () => {
    const e = form.title.trim().length < 3 ? 'Give the course a title (at least 3 characters).' : null
    setErr(e); if (!e) saveDetails.mutate()
  }
  const emptyTitle = mods.some(m => !m.title.trim())
  return <>
    <div className="row"><Badge kind={c.status === 'published' ? 'good' : 'warn'} dot>{c.status === 'published' ? 'Published' : 'Draft'}</Badge>
      {dirty && <Badge kind="warn">Unpublished changes</Badge>}<span className="sp" />
      <span className="xs muted">{c.students} students · {c.term}</span></div>
    <div className="g g-12">
      <div className="stack">
        <Card title="Course details">
          <Field label="Title" htmlFor="cm-t" error={err}><input className={`inp ${err ? 'bad' : ''}`} id="cm-t" value={form.title} maxLength={200} onChange={e => set('title', e.target.value)} /></Field>
          <div style={{ marginTop: 10 }}><Field label="Description" htmlFor="cm-d"><textarea className="inp" id="cm-d" rows={4} maxLength={4000} value={form.description} onChange={e => set('description', e.target.value)} /></Field></div>
          <div className="g g2" style={{ marginTop: 10 }}>
            <Field label="Status" htmlFor="cm-st"><select className="inp" id="cm-st" value={form.status} onChange={e => set('status', e.target.value)}><option value="published">Published — visible to students</option><option value="draft">Draft — hidden from students</option></select></Field>
            <div className="field"><label>&nbsp;</label><Switch id="cm-vf" checked={form.vf_enabled} onChange={v => set('vf_enabled', v)} label="Virtual faculty lessons enabled" /></div>
          </div>
          <div className="field" style={{ marginTop: 10 }}><label>Learning outcomes</label><ListEditor items={form.outcomes} onChange={v => set('outcomes', v)} placeholder="Add outcome" label="Outcome" /></div>
          <div className="row" style={{ marginTop: 12 }}><button className="btn pri" onClick={submitDetails} disabled={saveDetails.isPending}><Icon n="save" />{saveDetails.isPending ? 'Saving…' : 'Save settings'}</button></div>
        </Card>
        <Card title="Materials">
          <div className="list">{c.lessons.map((l: any) => <div className="li" key={l.id}><div className="ic teal"><Icon n="cap" /></div>
            <div className="bd"><div className="tt small">{l.title}</div><div className="ds">Virtual faculty lesson · v{l.version} · {l.status}</div></div>
            <Link className="btn sm ghost" to={`/l-editor?lesson=${l.id}`}>Edit</Link></div>)}
            {c.assessments.map((a: any) => <div className="li" key={a.id}><div className="ic"><Icon n={a.type === 'quiz' ? 'checkc' : 'clip'} /></div>
              <div className="bd"><div className="tt small">{a.title}</div><div className="ds">{a.type} · {a.status}</div></div>
              <Link className="btn sm ghost" to={`/l-builder?id=${a.id}`}>Edit</Link></div>)}</div>
          <p className="xs muted" style={{ marginTop: 8 }}>File uploads go through the university media server and approval workflow (not part of this prototype).</p>
        </Card>
      </div>
      <Card title="Modules & lessons" actions={<span className="xs muted">Drag or use arrows to reorder</span>}>
        {!mods.length && <Empty icon="layers" title="This course has no modules yet">Add a module to start building the outline.</Empty>}
        <div className="col">{mods.map((m, i) => <div key={m.key} className="card flat" style={{ padding: 12, opacity: drag === i ? .5 : 1 }} draggable
          onDragStart={() => setDrag(i)} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (drag != null && drag !== i) move(drag, i); setDrag(null) }} onDragEnd={() => setDrag(null)}>
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <span className="mono xs muted" aria-hidden>⋮⋮</span><span className="xs muted" style={{ whiteSpace: 'nowrap' }}>Module {i + 1}</span>
            <input className={`inp ${!m.title.trim() ? 'bad' : ''}`} value={m.title} aria-label={`Module ${i + 1} title`} onChange={e => upd(ms => ms.map((x, k) => k === i ? { ...x, title: e.target.value } : x))} />
            <button className="iconbtn" aria-label="Move module up" disabled={!i} onClick={() => move(i, i - 1)} style={{ transform: 'rotate(180deg)' }}><Icon n="chevd" /></button>
            <button className="iconbtn" aria-label="Move module down" disabled={i === mods.length - 1} onClick={() => move(i, i + 1)}><Icon n="chevd" /></button>
          </div>
          <div className="row" style={{ marginTop: 6 }}>
            <Badge kind={m.published ? 'good' : 'warn'}>{m.published ? 'Published' : 'Draft'}</Badge>
            <button className="btn sm ghost" onClick={() => upd(ms => ms.map((x, k) => k === i ? { ...x, published: !x.published } : x))}>{m.published ? 'Unpublish' : 'Publish'}</button>
            <span className="sp" />
            <button className="btn sm ghost" onClick={() => { if (!m.items.length || confirm(`Remove “${m.title}” and its ${m.items.length} item(s) from the outline?`)) upd(ms => ms.filter((_, k) => k !== i)) }}><Icon n="x" />Remove module</button>
          </div>
          <div className="col" style={{ marginTop: 8, paddingLeft: 12 }}>
            {m.items.map((it, j) => <div className="row small" key={it.id} style={{ flexWrap: 'nowrap' }}>
              <Icon n={TYPE_IC[it.type] || 'file'} /><span style={{ flex: 1, minWidth: 0 }}>{it.title} <span className="xs muted">· {it.dur} min</span></span>
              {(it.vf || it.type === 'virtual') && <span className="ai-tag">VF</span>}
              <button className="iconbtn" aria-label={`Move ${it.title} up`} disabled={!j} onClick={() => moveItem(i, j, j - 1)} style={{ transform: 'rotate(180deg)' }}><Icon n="chevd" /></button>
              <button className="iconbtn" aria-label={`Move ${it.title} down`} disabled={j === m.items.length - 1} onClick={() => moveItem(i, j, j + 1)}><Icon n="chevd" /></button>
              <button className="iconbtn" aria-label={`Edit ${it.title}`} onClick={() => setItemEdit({ m: i, i: j })}><Icon n="edit" /></button>
              <button className="iconbtn" aria-label={`Remove ${it.title}`} onClick={() => upd(ms => ms.map((x, k) => k === i ? { ...x, items: x.items.filter((_, z) => z !== j) } : x))}><Icon n="x" /></button>
            </div>)}
            <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setItemEdit({ m: i, i: null })}><Icon n="plus" />Add item</button>
          </div>
        </div>)}</div>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn sm" onClick={() => upd(ms => [...ms, { key: key(), title: 'New module', published: false, items: [] }])}><Icon n="plus" />Add module</button>
          <span className="sp" />
          {dirty && <button className="btn sm ghost" onClick={() => q.refetch().then(() => setDirty(false))}>Discard changes</button>}
          <button className="btn pri" disabled={!dirty || publish.isPending || emptyTitle} onClick={() => publish.mutate()}><Icon n="upload" />{publish.isPending ? 'Publishing…' : 'Publish changes'}</button>
        </div>
        {emptyTitle && <InlineErr msg="Every module needs a title." />}
      </Card>
    </div>
    {itemEdit && <ItemModal course={c} item={itemEdit.i != null ? mods[itemEdit.m].items[itemEdit.i] : null} allIds={mods.flatMap(m => m.items.map(x => x.id))}
      onClose={() => setItemEdit(null)} onSave={it => { upd(ms => ms.map((x, k) => k !== itemEdit.m ? x : { ...x, items: itemEdit.i != null ? x.items.map((y, z) => z === itemEdit.i ? it : y) : [...x.items, it] })); setItemEdit(null) }} />}
  </>
}

function ItemModal({ course, item, allIds, onClose, onSave }: { course: any; item: Item | null; allIds: string[]; onClose: () => void; onSave: (i: Item) => void }) {
  const [f, setF] = useState<Item>(item ? { ...item, lesson_id: item.lesson_id || (course.lessons.some((l: any) => l.id === item.id) ? item.id : undefined) } : { id: '', type: 'video', title: '', dur: 15 })
  const [err, setErr] = useState<string | null>(null)
  const save = () => {
    const title = f.title.trim()
    if (!title) return setErr('Give the item a title.')
    if (!(f.dur >= 1 && f.dur <= 600)) return setErr('Duration must be between 1 and 600 minutes.')
    let id = f.id || (f.type === 'virtual' && f.lesson_id) || f.assessment_id || `i${Date.now().toString(36)}`
    if (!item && allIds.includes(id)) id = `${id}-${Date.now().toString(36)}`.slice(0, 32)
    if (f.type === 'virtual' && !f.lesson_id) return setErr('Choose the virtual faculty lesson.')
    onSave({ ...f, id, title, vf: f.type === 'virtual' || undefined })
  }
  return <Modal title={item ? 'Edit item' : 'Add item'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn pri" onClick={save}>Save item</button></>}>
    <div className="g g2">
      <Field label="Type" htmlFor="it-type"><select className="inp" id="it-type" value={f.type} onChange={e => setF({ ...f, type: e.target.value })}>{TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
      <Field label="Duration (minutes)" htmlFor="it-dur"><input className="inp" id="it-dur" type="number" min={1} max={600} value={f.dur} onChange={e => setF({ ...f, dur: +e.target.value })} /></Field>
      <div style={{ gridColumn: '1/-1' }}><Field label="Title" htmlFor="it-t" error={err}><input className="inp" id="it-t" maxLength={200} value={f.title} onChange={e => setF({ ...f, title: e.target.value })} /></Field></div>
      {f.type === 'virtual' && <div style={{ gridColumn: '1/-1' }}><Field label="Virtual faculty lesson" htmlFor="it-l"><select className="inp" id="it-l" value={f.lesson_id || ''} onChange={e => { const l = course.lessons.find((x: any) => x.id === e.target.value); setF({ ...f, lesson_id: e.target.value, title: f.title || l?.title || '' }) }}>
        <option value="">Choose…</option>{course.lessons.map((l: any) => <option key={l.id} value={l.id}>{l.title}</option>)}</select></Field></div>}
      {(f.type === 'quiz' || f.type === 'assignment') && <div style={{ gridColumn: '1/-1' }}><Field label="Linked assessment (optional)" htmlFor="it-a"><select className="inp" id="it-a" value={f.assessment_id || ''} onChange={e => setF({ ...f, assessment_id: e.target.value || undefined })}>
        <option value="">None</option>{course.assessments.map((a: any) => <option key={a.id} value={a.id}>{a.title}</option>)}</select></Field></div>}
    </div>
  </Modal>
}

function Roster({ cid }: { cid: string }) {
  const q = useQuery({ queryKey: ['lect-roster', cid], queryFn: () => get<any[]>(`/api/lecturer/courses/${cid}/roster`) })
  const [f, setF] = useState('')
  if (q.isLoading) return <Loading />
  if (q.error) return <ErrorBox error={q.error} retry={() => q.refetch()} />
  const rows = (q.data || []).filter(s => !f || `${s.name} ${s.student_no}`.toLowerCase().includes(f.toLowerCase()))
  return <Card title={`Enrolled students (${q.data!.length})`} actions={<input className="inp" style={{ maxWidth: 220 }} placeholder="Filter by name or ID" aria-label="Filter students" value={f} onChange={e => setF(e.target.value)} />}>
    {!rows.length ? <Empty icon="users" title={q.data!.length ? 'No students match' : 'No students enrolled yet'} /> :
      <div className="tbl-wrap"><table className="t"><thead><tr><th>Student</th><th>Progress</th><th className="n">Average</th><th className="n">Submitted</th><th className="n">VF lessons</th><th>Last active</th><th>Support flags</th></tr></thead>
        <tbody>{rows.map(s => <tr key={s.id}><td><div className="nm small">{s.name}</div><div className="xs muted">{s.student_no}</div></td>
          <td style={{ minWidth: 120 }}><div className="row" style={{ flexWrap: 'nowrap' }}><Bar v={s.progress} /><span className="xs">{s.progress}%</span></div></td>
          <td className="n">{s.avg != null ? `${s.avg}%` : '—'}</td><td className="n">{s.submitted}</td><td className="n">{s.vf_completed}</td><td className="small">{rel(s.last_active)}</td>
          <td>{s.reasons.length ? s.reasons.map((r: string) => <span key={r} className="b warn" style={{ margin: 2 }}>{r}</span>) : <span className="faint">—</span>}</td></tr>)}</tbody></table></div>}
  </Card>
}
