import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Icon } from '../../components/Icon'
import { Badge, Card, Empty, ErrorBox, Field, Loading, Modal, PageHead, Seg, useToast } from '../../components/ui'
import { del, get, post, put } from '../../lib/api'
import { fmtDate } from '../../lib/format'
import { InlineErr, Sel, useMeta } from './shared'

type Notice = { id: string; title: string; body: string; scope: string; faculty_id: string | null; audience: string; priority: string; publish_at: string | null; status: string; state: string; author: string | null; reads: number }
type Ev = { id: string; title: string; kind: string; start: string; end: string | null; location: string | null; course_id: string | null }
const STATE_KIND: Record<string, string> = { published: 'good', scheduled: 'info', draft: 'out', withdrawn: 'bad' }
const PRI_KIND: Record<string, string> = { normal: 'out', high: 'warn', urgent: 'bad' }
const KIND_LABEL: Record<string, string> = { exam: 'Examination', due: 'Deadline', uni: 'University event' }

const localInput = (iso?: string | null) => { const d = iso ? new Date(iso) : new Date(); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}` }
const blank = () => ({ title: '', body: '', scope: 'uni', faculty_id: '', priority: 'normal', publish_at: localInput(), status: 'published' })

export default function Notices() {
  const meta = useMeta(); const toast = useToast(); const qc = useQueryClient()
  const [filter, setFilter] = useState('all')
  const list = useQuery({ queryKey: ['admin-notices'], queryFn: () => get<{ items: Notice[] }>('/api/admin/notices') })
  const cal = useQuery({ queryKey: ['admin-calendar'], queryFn: () => get<Ev[]>('/api/admin/calendar') })
  const [f, setF] = useState(blank()); const [editId, setEditId] = useState<string | null>(null)
  const [errs, setErrs] = useState<Record<string, string>>({}); const [serr, setSerr] = useState<string | null>(null)
  const [preview, setPreview] = useState(false)
  const [evEdit, setEvEdit] = useState<Ev | 'new' | null>(null)
  const refresh = () => { qc.invalidateQueries({ queryKey: ['admin-notices'] }) }
  const validate = () => {
    const e: Record<string, string> = {}
    if (f.title.trim().length < 3) e.title = 'Add a title (at least 3 characters).'
    if (f.body.trim().length < 10) e.body = 'Write the notice (at least 10 characters).'
    if (f.scope === 'faculty' && !f.faculty_id) e.scope = 'Choose the faculty.'
    if (!f.publish_at) e.at = 'Choose when to publish.'
    setErrs(e); return !Object.keys(e).length
  }
  const save = useMutation({
    mutationFn: (status: string) => { const body = { ...f, status, faculty_id: f.scope === 'faculty' ? f.faculty_id : null, publish_at: new Date(f.publish_at).toISOString(), title: f.title.trim(), body: f.body.trim() }; return editId ? put<any>(`/api/admin/notices/${editId}`, body) : post<any>('/api/admin/notices', body) },
    onSuccess: (r: any, status) => { toast(status === 'draft' ? 'Draft saved' : r.state === 'scheduled' ? 'Notice scheduled' : editId ? 'Notice updated' : 'Notice published'); setF(blank()); setEditId(null); setSerr(null); refresh() },
    onError: (e: any) => setSerr(e.message) })
  const act = useMutation({ mutationFn: ({ id, kind }: { id: string; kind: 'withdraw' | 'delete' }) => kind === 'withdraw' ? post(`/api/admin/notices/${id}/withdraw`) : del(`/api/admin/notices/${id}`),
    onSuccess: (_, v) => { toast(v.kind === 'withdraw' ? 'Notice withdrawn' : 'Notice deleted'); refresh() }, onError: (e: any) => toast(e.message, true) })
  const future = f.publish_at && new Date(f.publish_at) > new Date()
  const items = (list.data?.items || []).filter(n => filter === 'all' || n.state === filter)
  const facName = (id: string) => meta.data?.faculties.find(x => x.id === id)?.short || id
  return <>
    <PageHead no={27} title="Notices & academic calendar" sub="Create university and faculty notices for chosen audiences, schedule them, and manage academic dates." />
    <div className="g g2">
      <Card title={editId ? 'Edit notice' : 'New notice'} actions={editId && <button className="btn sm ghost" onClick={() => { setEditId(null); setF(blank()); setErrs({}) }}>Cancel edit</button>}>
        <div className="col">
          <Field label="Title" htmlFor="no-t" error={errs.title}><input className={`inp ${errs.title ? 'bad' : ''}`} id="no-t" maxLength={300} value={f.title} onChange={e => setF({ ...f, title: e.target.value })} /></Field>
          <Field label="Message" htmlFor="no-b" error={errs.body} hint={`${f.body.trim().length} characters (minimum 10)`}><textarea className={`inp ${errs.body ? 'bad' : ''}`} id="no-b" rows={4} maxLength={5000} value={f.body} onChange={e => setF({ ...f, body: e.target.value })} /></Field>
          <div className="g g2">
            <Field label="Audience" htmlFor="no-scope" error={errs.scope}><select className="inp" id="no-scope" value={f.scope === 'faculty' ? `fac:${f.faculty_id}` : 'uni'} onChange={e => { const v = e.target.value; setF(v === 'uni' ? { ...f, scope: 'uni', faculty_id: '' } : { ...f, scope: 'faculty', faculty_id: v.slice(4) }) }}>
              <option value="uni">All learners & staff</option>{(meta.data?.faculties || []).map(x => <option key={x.id} value={`fac:${x.id}`}>{x.short}</option>)}</select></Field>
            <Sel id="no-pri" label="Priority" value={f.priority} onChange={v => setF({ ...f, priority: v })} options={[['normal', 'Normal'], ['high', 'High'], ['urgent', 'Urgent']]} />
            <Field label="Publish on" htmlFor="no-at" error={errs.at} hint={future ? 'Future date — will show as Scheduled' : 'Now or in the past — publishes immediately'}><input className="inp" type="datetime-local" id="no-at" value={f.publish_at} onChange={e => setF({ ...f, publish_at: e.target.value })} /></Field>
          </div>
          <InlineErr msg={serr} />
          <div className="row"><button className="btn" onClick={() => validate() && setPreview(true)}><Icon n="eye" />Preview</button>
            <button className="btn" disabled={save.isPending} onClick={() => validate() && save.mutate('draft')}><Icon n="save" />Save draft</button>
            <button className="btn pri" disabled={save.isPending} onClick={() => validate() && save.mutate('published')}><Icon n="mega" />{save.isPending ? 'Saving…' : future ? 'Schedule notice' : editId ? 'Save & publish' : 'Publish notice'}</button></div>
        </div>
      </Card>
      <Card title="Academic calendar" actions={<button className="btn sm pri" onClick={() => setEvEdit('new')}><Icon n="cal" />Add date</button>}>
        {cal.isLoading ? <Loading /> : cal.error ? <ErrorBox error={cal.error} retry={() => cal.refetch()} /> : !cal.data!.length ? <Empty icon="cal" title="No upcoming academic dates" /> :
          <div className="list">{cal.data!.map(e => <div className="li" key={e.id}><div className={`ic ${e.kind === 'exam' ? 'bad' : e.kind === 'due' ? 'warn' : 'gold'}`}><Icon n="cal" /></div>
            <div className="bd"><div className="tt small">{e.title}</div><div className="ds">{KIND_LABEL[e.kind] || e.kind} · {fmtDate(e.start, true)}{e.end ? ` – ${fmtDate(e.end, true)}` : ''}{e.location ? ` · ${e.location}` : ''}</div></div>
            {e.course_id ? <span className="xs muted" title="Course dates are managed by the course lecturer">Course</span> : <button className="btn sm ghost" aria-label={`Edit ${e.title}`} onClick={() => setEvEdit(e)}><Icon n="edit" /></button>}</div>)}</div>}
      </Card>
    </div>
    <div style={{ marginTop: 16 }} /><Card title="Scheduled & published notices" actions={<Seg value={filter} onChange={setFilter} options={[['all', 'All'], ['published', 'Published'], ['scheduled', 'Scheduled'], ['draft', 'Drafts'], ['withdrawn', 'Withdrawn']]} />}>
      {list.isLoading ? <Loading /> : list.error ? <ErrorBox error={list.error} retry={() => list.refetch()} /> : !items.length ? <Empty icon="mega" title="No notices here" /> :
        <div className="list">{items.map(n => <div className="li" key={n.id}><div className="ic gold"><Icon n={n.scope === 'faculty' ? 'bldg' : 'mega'} /></div>
          <div className="bd"><div className="tt">{n.title} {n.priority !== 'normal' && <Badge kind={PRI_KIND[n.priority]}>{n.priority}</Badge>}</div>
            <div className="ds">{n.scope === 'faculty' ? facName(n.faculty_id || '') : n.audience} · {n.state === 'scheduled' ? 'Scheduled ' : ''}{fmtDate(n.publish_at, true)}{n.author ? ` · ${n.author}` : ''} · {n.reads} read</div>
            <div className="small" style={{ marginTop: 2 }}>{n.body.length > 160 ? n.body.slice(0, 160) + '…' : n.body}</div></div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, flex: 'none' }}><Badge kind={STATE_KIND[n.state]}>{n.state[0].toUpperCase() + n.state.slice(1)}</Badge>
            <div className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
              {n.state !== 'withdrawn' && <button className="btn sm ghost" aria-label={`Edit ${n.title}`} onClick={() => { setEditId(n.id); setErrs({}); setF({ title: n.title, body: n.body, scope: n.scope === 'faculty' ? 'faculty' : 'uni', faculty_id: n.faculty_id || '', priority: n.priority, publish_at: localInput(n.publish_at), status: n.status }); window.scrollTo({ top: 0, behavior: 'smooth' }) }}><Icon n="edit" /></button>}
              {n.state === 'published' && <button className="btn sm ghost" disabled={act.isPending} onClick={() => confirm(`Withdraw “${n.title}”? Learners will no longer see it.`) && act.mutate({ id: n.id, kind: 'withdraw' })}>Withdraw</button>}
              {n.state !== 'published' && <button className="btn sm ghost" aria-label={`Delete ${n.title}`} disabled={act.isPending} onClick={() => confirm(`Delete “${n.title}”?`) && act.mutate({ id: n.id, kind: 'delete' })}><Icon n="x" /></button>}
            </div></div></div>)}</div>}
    </Card>
    {preview && <Modal title="Preview" onClose={() => setPreview(false)} footer={<button className="btn" onClick={() => setPreview(false)}>Close</button>}>
      <div className="li unread"><div className="ic gold"><Icon n="bldg" /></div><div className="bd"><div className="tt">{f.title} {f.priority !== 'normal' && <Badge kind={PRI_KIND[f.priority]}>{f.priority}</Badge>}</div><div className="ds" style={{ whiteSpace: 'pre-wrap' }}>{f.body}</div>
        <div className="xs muted">University notice · {f.scope === 'faculty' ? facName(f.faculty_id) : 'All learners & staff'} · {future ? 'Scheduled ' : ''}{fmtDate(new Date(f.publish_at).toISOString(), true)}</div></div></div>
    </Modal>}
    {evEdit && <EventModal ev={evEdit === 'new' ? null : evEdit} onClose={() => setEvEdit(null)} onDone={m => { toast(m); setEvEdit(null); qc.invalidateQueries({ queryKey: ['admin-calendar'] }) }} />}
  </>
}

function EventModal({ ev, onClose, onDone }: { ev: Ev | null; onClose: () => void; onDone: (m: string) => void }) {
  const [f, setF] = useState({ title: ev?.title || '', kind: ev?.kind || 'exam', start: ev ? localInput(ev.start) : '', end: ev?.end ? localInput(ev.end) : '', location: ev?.location || '' })
  const [err, setErr] = useState<string | null>(null)
  const save = useMutation({ mutationFn: () => { const b = { ...f, title: f.title.trim(), start: new Date(f.start).toISOString(), end: f.end ? new Date(f.end).toISOString() : null, location: f.location.trim() || null }; return ev ? put(`/api/admin/calendar/${ev.id}`, b) : post('/api/admin/calendar', b) },
    onSuccess: () => onDone(ev ? 'Academic date updated' : 'Added to the academic calendar'), onError: (e: any) => setErr(e.message) })
  const rm = useMutation({ mutationFn: () => del(`/api/admin/calendar/${ev!.id}`), onSuccess: () => onDone('Academic date removed'), onError: (e: any) => setErr(e.message) })
  const submit = () => {
    if (f.title.trim().length < 3) return setErr('Name the event first.')
    if (!f.start) return setErr('Choose the date and time.')
    if (f.end && f.end < f.start) return setErr('The event must end after it starts.')
    setErr(null); save.mutate()
  }
  return <Modal title={ev ? 'Edit academic date' : 'New academic date'} onClose={onClose} footer={<>{ev && <button className="btn danger" style={{ marginRight: 'auto' }} disabled={rm.isPending} onClick={() => rm.mutate()}>Remove</button>}<button className="btn" onClick={onClose}>Cancel</button><button className="btn pri" disabled={save.isPending} onClick={submit}>{save.isPending ? 'Saving…' : ev ? 'Save' : 'Add to calendar'}</button></>}>
    <div className="g g2">
      <div style={{ gridColumn: '1/-1' }}><Field label="Event" htmlFor="ev-t"><input className="inp" id="ev-t" maxLength={300} placeholder="e.g. Examination period begins" value={f.title} onChange={e => setF({ ...f, title: e.target.value })} /></Field></div>
      <Sel id="ev-k" label="Type" value={f.kind} onChange={v => setF({ ...f, kind: v })} options={[['exam', 'Examination'], ['due', 'Deadline'], ['uni', 'University event']]} />
      <Field label="Location (optional)" htmlFor="ev-l"><input className="inp" id="ev-l" maxLength={200} value={f.location} onChange={e => setF({ ...f, location: e.target.value })} /></Field>
      <Field label="Starts" htmlFor="ev-s"><input className="inp" type="datetime-local" id="ev-s" value={f.start} onChange={e => setF({ ...f, start: e.target.value })} /></Field>
      <Field label="Ends (optional)" htmlFor="ev-e"><input className="inp" type="datetime-local" id="ev-e" value={f.end} onChange={e => setF({ ...f, end: e.target.value })} /></Field>
    </div>
    <div style={{ marginTop: 8 }}><InlineErr msg={err} /></div>
  </Modal>
}
