import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon } from '../../components/Icon'
import { Badge, Bar, Empty, ErrorBox, Field, Loading, Modal, PageHead, useToast } from '../../components/ui'
import { get, post } from '../../lib/api'
import { CourseCard, CourseTile, errText } from './shared'

type Cat = { courses: CourseCard[]; faculties: { id: string; short: string; name: string }[]; programmes: { id: string; name: string; faculty_id: string }[] }
const FORMATS: [string, string][] = [['all', 'All'], ['Blended', 'Blended'], ['Online', 'Online'], ['On campus', 'On campus'], ['Online, self-paced', 'Self-paced']]

export default function Catalogue() {
  const q = useQuery({ queryKey: ['s-catalogue'], queryFn: () => get<Cat>('/api/student/catalogue') })
  const [f, setF] = useState({ q: '', fac: 'all', prog: 'all', fmt: 'all', vf: false, enrolled: 'all' })
  const [open, setOpen] = useState<CourseCard | null>(null)
  const list = useMemo(() => {
    const t = f.q.trim().toLowerCase()
    return (q.data?.courses || []).filter(c => (!t || `${c.title} ${c.code} ${c.description} ${c.lecturer || ''}`.toLowerCase().includes(t))
      && (f.fac === 'all' || c.faculty_id === f.fac) && (f.prog === 'all' || c.programme_id === f.prog) && (f.fmt === 'all' || c.format === f.fmt)
      && (!f.vf || c.vf) && (f.enrolled === 'all' || (f.enrolled === 'yes') === c.enrolled))
  }, [q.data, f])
  const set = (k: keyof typeof f) => (e: any) => setF(x => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))
  const clear = () => setF({ q: '', fac: 'all', prog: 'all', fmt: 'all', vf: false, enrolled: 'all' })
  return <>
    <PageHead no={3} title="Course catalogue" sub="Search and filter published courses. Course codes prefixed HB- are fictional examples for this concept platform." />
    {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} retry={() => q.refetch()} /> : <>
      <div className="card" style={{ padding: '12px 14px' }}><div className="filters">
        <div className="field" style={{ flex: '1 1 240px' }}><label htmlFor="ct-q">Search</label><input className="inp" id="ct-q" placeholder="Title, code, lecturer or keyword" value={f.q} onChange={set('q')} /></div>
        <div className="field"><label htmlFor="ct-fac">Faculty / centre</label><select className="inp" id="ct-fac" value={f.fac} onChange={set('fac')}><option value="all">All</option>
          {q.data!.faculties.map(x => <option key={x.id} value={x.id}>{x.short}</option>)}</select></div>
        <div className="field"><label htmlFor="ct-prog">Programme</label><select className="inp" id="ct-prog" value={f.prog} onChange={set('prog')}><option value="all">All</option>
          {q.data!.programmes.filter(p => f.fac === 'all' || p.faculty_id === f.fac).map(p => <option key={p.id} value={p.id}>{p.name.replace(/^(BSc|BEng|MSc|BA) \(Hons\) /, '')}</option>)}</select></div>
        <div className="field"><label htmlFor="ct-fmt">Format</label><select className="inp" id="ct-fmt" value={f.fmt} onChange={set('fmt')}>{FORMATS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
        <div className="field"><label htmlFor="ct-en">Enrolment</label><select className="inp" id="ct-en" value={f.enrolled} onChange={set('enrolled')}><option value="all">All</option><option value="yes">Enrolled</option><option value="no">Available</option></select></div>
        <label className="chk" style={{ marginBottom: 8 }}><input type="checkbox" checked={f.vf} onChange={set('vf')} />Has virtual faculty</label>
      </div></div>
      <div className="row sb"><span className="small muted" aria-live="polite">{list.length} of {q.data!.courses.length} courses</span><span className="demo-tag">Demo course data</span></div>
      {list.length ? <div className="g g4">{list.map(c => <CourseTile key={c.id} c={c} onOpen={() => setOpen(c)}>
        <p className="xs muted">{c.description}</p>
        <div className="row xs muted"><Icon n="user" />{c.lecturer || 'To be confirmed'}</div>
        <div className="row xs muted"><Icon n="clock" />{c.weeks ? `${c.weeks} weeks · ` : ''}{c.format}</div>
        <div className="row" style={{ marginTop: 'auto', flexWrap: 'nowrap' }}>{c.enrolled ? <><Badge kind="good">Enrolled</Badge><Bar v={c.progress ?? 0} /></> : c.requested ? <Badge kind="info">Requested</Badge> : <Badge kind="out">Available</Badge>}
          {c.vf && <span className="ai-tag" title="Virtual faculty"><Icon n="cap" />VF</span>}</div>
      </CourseTile>)}</div>
        : <Empty icon="search" title="No courses match">Clear a filter or try a different keyword. <button className="link-btn" onClick={clear}>Clear filters</button></Empty>}
      {open && <CourseModal c={open} onClose={() => setOpen(null)} />}
    </>}
  </>
}

function CourseModal({ c, onClose }: { c: CourseCard; onClose: () => void }) {
  const nav = useNavigate(); const toast = useToast(); const qc = useQueryClient()
  const [note, setNote] = useState('')
  const [asking, setAsking] = useState(false)
  const m = useMutation({
    mutationFn: () => post<{ id: string; duplicate: boolean }>(`/api/student/catalogue/${c.id}/request`, { note }),
    onSuccess: r => { toast(r.duplicate ? `You already have an open request (${r.id}).` : `Enrolment request ${r.id} sent to the programme coordinator`); qc.invalidateQueries({ queryKey: ['s-catalogue'] }); qc.invalidateQueries({ queryKey: ['s-tickets'] }); onClose() },
    onError: (e: any) => toast(errText(e), true),
  })
  return <Modal title={c.title} onClose={onClose} footer={c.enrolled
    ? <><button className="btn" onClick={onClose}>Close</button><button className="btn pri" onClick={() => nav(`/s-course/${c.id}`)}>Open course</button></>
    : c.requested ? <><span className="small muted">Request pending with the programme coordinator</span><button className="btn" onClick={onClose}>Close</button></>
      : asking ? <><button className="btn" onClick={() => setAsking(false)}>Back</button><button className="btn pri" disabled={m.isPending} onClick={() => m.mutate()}><Icon n="send" />{m.isPending ? 'Sending…' : 'Send request'}</button></>
        : <><button className="btn" onClick={onClose}>Close</button><button className="btn pri" onClick={() => setAsking(true)}>Request enrolment</button></>}>
    <div className="row"><Badge>{c.code}</Badge><Badge kind="out">{c.faculty_name}</Badge><Badge kind="out">{c.credits ? `${c.credits} credits` : 'Short course'}</Badge>{c.enrolled && <Badge kind="good">Enrolled</Badge>}</div>
    <p>{c.description}</p>
    {c.outcomes.length > 0 && <div><div className="eyebrow">Learning outcomes</div><ul className="small">{c.outcomes.map(o => <li key={o}>{o}</li>)}</ul></div>}
    <dl className="kv"><dt>Lecturer</dt><dd>{c.lecturer || 'To be confirmed'}</dd>{c.vf_name && <><dt>Digital lecturer</dt><dd>{c.vf_name} <span className="xs muted">(AI)</span></dd></>}
      <dt>Duration</dt><dd>{c.weeks ? `${c.weeks} weeks · ` : ''}{c.format}</dd><dt>Semester</dt><dd>{c.term}</dd></dl>
    {asking && <Field label="Note for the coordinator (optional)" htmlFor="en-note" hint="For example, why you’d like to join. Your request is logged as a support request.">
      <textarea id="en-note" className="inp" rows={3} maxLength={1000} value={note} onChange={e => setNote(e.target.value)} /></Field>}
  </Modal>
}
