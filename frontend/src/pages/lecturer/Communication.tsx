import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Icon } from '../../components/Icon'
import { Badge, Card, Empty, ErrorBox, Field, Loading, PageHead, Switch, Tabs, useToast } from '../../components/ui'
import { del, get, post, put } from '../../lib/api'
import { fmtDate, rel } from '../../lib/format'
import { fromLocalInput, InlineErr, useMyCourses } from './shared'

export default function Communication() {
  const [sp] = useSearchParams()
  const [tab, setTab] = useState(sp.get('to') ? 'msg' : 'ann')
  const courses = useMyCourses()
  if (courses.isLoading) return <Loading />
  if (courses.error) return <ErrorBox error={courses.error} retry={() => courses.refetch()} />
  if (!courses.data?.length) return <><PageHead no={20} title="Communication" /><Empty icon="msg" title="No courses assigned" /></>
  return <>
    <PageHead no={20} title="Communication" sub="Announcements, messages, course questions and assessment reminders." />
    <Tabs tabs={[['ann', 'Post announcement'], ['msg', 'Message students'], ['q', 'Course questions'], ['rem', 'Assessment reminders']]} value={tab} onChange={setTab} />
    {tab === 'ann' ? <Announce courses={courses.data} /> : tab === 'msg' ? <GroupMessage courses={courses.data} initialCourse={sp.get('course')} initialTo={sp.get('to')} /> : tab === 'q' ? <Questions /> : <Reminders />}
  </>
}

function Announce({ courses }: { courses: any[] }) {
  const qc = useQueryClient(); const toast = useToast()
  const list = useQuery({ queryKey: ['lect-anns'], queryFn: () => get<any[]>('/api/lecturer/comms/announcements') })
  const [f, setF] = useState({ course_id: courses[0].id, title: '', body: '', priority: 'normal', when: 'now', at: '' })
  const [err, setErr] = useState<string | null>(null)
  const m = useMutation({ mutationFn: () => post<any>('/api/lecturer/comms/announcements', { course_id: f.course_id, title: f.title.trim(), body: f.body.trim(), priority: f.priority, publish_at: f.when === 'later' ? fromLocalInput(f.at) : null }),
    onSuccess: r => { toast(r.status === 'scheduled' ? `Scheduled for ${fmtDate(r.publish_at, true)}` : 'Announcement posted — students see it now'); setF({ ...f, title: '', body: '', at: '' }); qc.invalidateQueries({ queryKey: ['lect-anns'] }) },
    onError: (e: any) => setErr(e.message) })
  const wd = useMutation({ mutationFn: (id: string) => del(`/api/lecturer/comms/announcements/${id}`), onSuccess: () => { toast('Announcement withdrawn'); qc.invalidateQueries({ queryKey: ['lect-anns'] }) }, onError: (e: any) => toast(e.message, true) })
  const submit = () => {
    const e = f.title.trim().length < 3 ? 'Add a title (at least 3 characters).' : f.body.trim().length < 10 ? 'Write a message (at least 10 characters).'
      : f.when === 'later' && (!f.at || new Date(f.at) <= new Date()) ? 'Choose a time in the future.' : null
    setErr(e); if (!e) m.mutate()
  }
  return <div className="g g-21">
    <Card><div className="g g2">
      <Field label="Course" htmlFor="la-c"><select className="inp" id="la-c" value={f.course_id} onChange={e => setF({ ...f, course_id: e.target.value })}>{courses.map(c => <option key={c.id} value={c.id}>{c.code} · {c.title}</option>)}</select></Field>
      <Field label="Publish" htmlFor="la-when"><select className="inp" id="la-when" value={f.when} onChange={e => setF({ ...f, when: e.target.value })}><option value="now">Now</option><option value="later">Schedule…</option></select></Field>
      {f.when === 'later' && <Field label="Publish at" htmlFor="la-at"><input className="inp" type="datetime-local" id="la-at" value={f.at} onChange={e => setF({ ...f, at: e.target.value })} /></Field>}
      <div style={{ gridColumn: '1/-1' }}><Field label="Title" htmlFor="la-t"><input className="inp" id="la-t" maxLength={300} placeholder="e.g. Tutorial moved to LT3" value={f.title} onChange={e => setF({ ...f, title: e.target.value })} /></Field></div>
      <div style={{ gridColumn: '1/-1' }}><Field label="Message" htmlFor="la-b"><textarea className="inp" id="la-b" rows={5} maxLength={5000} value={f.body} onChange={e => setF({ ...f, body: e.target.value })} /></Field></div>
      <Switch id="la-pri" checked={f.priority === 'high'} onChange={v => setF({ ...f, priority: v ? 'high' : 'normal' })} label="Mark as important" />
    </div>
      <InlineErr msg={err} />
      <div className="row" style={{ marginTop: 12 }}><button className="btn pri" disabled={m.isPending} onClick={submit}><Icon n="mega" />{f.when === 'later' ? 'Schedule announcement' : 'Post announcement'}</button></div>
    </Card>
    <Card title="Recently posted">
      {list.isLoading ? <Loading /> : list.error ? <ErrorBox error={list.error} /> : !list.data!.length ? <Empty icon="mega" title="No announcements yet" /> :
        <div className="list">{list.data!.map(a => <div className="li" key={a.id}><div className="ic teal"><Icon n="mega" /></div>
          <div className="bd"><div className="tt small">{a.title} {a.priority === 'high' && <Badge kind="bad">Important</Badge>}</div>
            <div className="ds">{a.course_code} · {a.status === 'scheduled' ? `scheduled ${fmtDate(a.publish_at, true)}` : rel(a.publish_at)} · read by {a.reads}/{a.audience}</div></div>
          {a.status === 'scheduled' ? <><Badge kind="warn">Scheduled</Badge>{a.mine && <button className="btn sm ghost" disabled={wd.isPending} onClick={() => wd.mutate(a.id)}>Withdraw</button>}</> : null}</div>)}</div>}
    </Card>
  </div>
}

function GroupMessage({ courses, initialCourse, initialTo }: { courses: any[]; initialCourse: string | null; initialTo: string | null }) {
  const toast = useToast()
  const [cid, setCid] = useState(initialCourse && courses.some(c => c.id === initialCourse) ? initialCourse : courses[0].id)
  const [to, setTo] = useState(initialTo || 'all'); const [aid, setAid] = useState(''); const [ids, setIds] = useState<string[]>([])
  const [subject, setSubject] = useState('Checking in')
  const [body, setBody] = useState('Hi {first name}, I noticed you haven’t been active in the course for a little while. Is there anything I can help with? My office hours are Thursday 14:00–16:00.')
  const [err, setErr] = useState<string | null>(null)
  const asses = useQuery({ queryKey: ['lect-assessments'], queryFn: () => get<any[]>('/api/lecturer/assessments') })
  const courseAs = (asses.data || []).filter(a => a.course_id === cid && a.status === 'published' && a.type !== 'exam')
  const aSel = aid || courseAs[0]?.id || ''
  const aud = useQuery({ queryKey: ['lect-aud', cid, aSel], queryFn: () => get<any>(`/api/lecturer/comms/audiences?course_id=${cid}${aSel ? `&assessment_id=${aSel}` : ''}`) })
  const m = useMutation({ mutationFn: () => post<any>('/api/lecturer/comms/messages', { course_id: cid, audience: to, assessment_id: to === 'not_submitted' ? aSel : null, user_ids: to === 'individual' ? ids : null, subject: subject.trim(), body: body.trim() }),
    onSuccess: r => toast(`Sent ${r.sent} private message${r.sent === 1 ? '' : 's'}`), onError: (e: any) => setErr(e.message) })
  const submit = () => {
    const e = subject.trim().length < 3 ? 'Add a subject.' : body.trim().length < 10 ? 'Write a message (at least 10 characters).' : to === 'individual' && !ids.length ? 'Choose at least one student.' : null
    setErr(e); if (!e) m.mutate()
  }
  const a = aud.data
  return <Card><div className="g g2">
    <Field label="Course" htmlFor="lm-c"><select className="inp" id="lm-c" value={cid} onChange={e => { setCid(e.target.value); setAid(''); setIds([]) }}>{courses.map(c => <option key={c.id} value={c.id}>{c.code} · {c.title}</option>)}</select></Field>
    <Field label="Recipients" htmlFor="lm-to"><select className="inp" id="lm-to" value={to} onChange={e => setTo(e.target.value)}>
      <option value="all">All students ({a?.all ?? '…'})</option><option value="at_risk">Students flagged for follow-up ({a?.at_risk ?? '…'})</option>
      <option value="not_submitted">Not yet submitted an assessment{to === 'not_submitted' && a ? ` (${a.not_submitted})` : ''}</option><option value="individual">Individual students…</option></select></Field>
    {to === 'not_submitted' && <Field label="Assessment" htmlFor="lm-a"><select className="inp" id="lm-a" value={aSel} onChange={e => setAid(e.target.value)}>{courseAs.map(x => <option key={x.id} value={x.id}>{x.title}</option>)}</select></Field>}
    {to === 'individual' && <div style={{ gridColumn: '1/-1' }}><Field label={`Students (${ids.length} selected)`} htmlFor="lm-ids"><select className="inp" id="lm-ids" multiple size={6} value={ids} onChange={e => setIds(Array.from(e.target.selectedOptions).map(o => o.value))}>
      {(a?.students || []).map((s: any) => <option key={s.id} value={s.id}>{s.name}{a.at_risk_ids.includes(s.id) ? ' · flagged' : ''}</option>)}</select></Field></div>}
    <div style={{ gridColumn: '1/-1' }}><Field label="Subject" htmlFor="lm-s"><input className="inp" id="lm-s" maxLength={300} value={subject} onChange={e => setSubject(e.target.value)} /></Field></div>
    <div style={{ gridColumn: '1/-1' }}><Field label="Message" htmlFor="lm-b" hint="{first name} is replaced for each student. Messages are private to each recipient."><textarea className="inp" id="lm-b" rows={5} maxLength={5000} value={body} onChange={e => setBody(e.target.value)} /></Field></div>
  </div>
    <InlineErr msg={err} />
    <div className="row" style={{ marginTop: 12 }}><button className="btn pri" disabled={m.isPending} onClick={submit}><Icon n="send" />{m.isPending ? 'Sending…' : 'Send'}</button></div>
  </Card>
}

function Questions() {
  const qc = useQueryClient()
  const list = useQuery({ queryKey: ['lect-threads'], queryFn: () => get<any[]>('/api/lecturer/comms/threads') })
  const [open, setOpen] = useState<string | null>(null); const [f, setF] = useState('all')
  if (list.isLoading) return <Loading />
  if (list.error) return <ErrorBox error={list.error} retry={() => list.refetch()} />
  const rows = list.data!.filter(t => f === 'all' || (f === 'reply' && t.needs_reply) || (f === 'public' && !t.private) || (f === 'private' && t.private))
  return <div className="g g-12">
    <Card title="Threads" actions={<select className="inp" style={{ width: 'auto' }} aria-label="Filter threads" value={f} onChange={e => setF(e.target.value)}><option value="all">All</option><option value="reply">Needs reply</option><option value="public">Course questions</option><option value="private">Private messages</option></select>}>
      {!rows.length ? <Empty icon="msg" title="No threads" /> : <div className="list">{rows.slice(0, 60).map(t => <button key={t.id} className="li" onClick={() => setOpen(t.id)}
        style={{ textAlign: 'left', border: 0, width: '100%', font: 'inherit', color: 'inherit', cursor: 'pointer', background: open === t.id ? 'var(--surface-2)' : 'none' }}>
        <div className="ic"><Icon n={t.private ? 'user' : 'msg'} /></div><div className="bd"><div className="tt small">{t.subject}</div><div className="ds">{t.course_code} · {t.by || '—'} · {t.replies} repl{t.replies === 1 ? 'y' : 'ies'} · {rel(t.last_at)}</div></div>
        {t.needs_reply ? <Badge kind="warn">Needs reply</Badge> : <Badge kind="good">Answered</Badge>}</button>)}</div>}
    </Card>
    <Card>{open ? <ThreadView key={open} id={open} onSent={() => qc.invalidateQueries({ queryKey: ['lect-threads'] })} /> : <Empty icon="msg" title="Open a thread to read and reply" />}</Card>
  </div>
}

function ThreadView({ id, onSent }: { id: string; onSent: () => void }) {
  const toast = useToast()
  const q = useQuery({ queryKey: ['lect-thread', id], queryFn: () => get<any>(`/api/lecturer/comms/threads/${id}`) })
  const [txt, setTxt] = useState(''); const [bad, setBad] = useState(false)
  const m = useMutation({ mutationFn: () => post(`/api/lecturer/comms/threads/${id}/messages`, { body: txt.trim() }), onSuccess: () => { setTxt(''); toast('Reply posted'); q.refetch(); onSent() }, onError: (e: any) => toast(e.message, true) })
  if (q.isLoading) return <Loading />
  if (q.error) return <ErrorBox error={q.error} retry={() => q.refetch()} />
  return <><div className="hd"><h3>{q.data.subject}</h3></div>
    <div className="chat" style={{ maxHeight: 380, overflow: 'auto' }}>{q.data.messages.map((m: any) => <div key={m.id} className={`msg ${m.mine ? 'me' : ''}`}><div className="bub"><div className="xs muted">{m.author} · {fmtDate(m.at, true)}</div>{m.body}</div></div>)}</div>
    <div className="row" style={{ marginTop: 10, flexWrap: 'nowrap' }}><input className={`inp ${bad ? 'bad' : ''}`} placeholder="Reply as lecturer…" aria-label="Reply" maxLength={5000} value={txt} onChange={e => { setTxt(e.target.value); setBad(false) }}
      onKeyDown={e => e.key === 'Enter' && (txt.trim().length < 2 ? setBad(true) : m.mutate())} />
      <button className="btn sm pri" disabled={m.isPending} onClick={() => txt.trim().length < 2 ? setBad(true) : m.mutate()}><Icon n="send" />Reply</button></div></>
}

function Reminders() {
  const toast = useToast(); const qc = useQueryClient()
  const list = useQuery({ queryKey: ['lect-rem'], queryFn: () => get<any[]>('/api/lecturer/comms/reminders') })
  const m = useMutation({ mutationFn: (x: { id: string; when: string[] }) => put(`/api/lecturer/comms/reminders/${x.id}`, { when: x.when }),
    onSuccess: (_, x) => { toast(x.when.length ? 'Reminder scheduled' : 'Reminders cancelled'); qc.invalidateQueries({ queryKey: ['lect-rem'] }) }, onError: (e: any) => toast(e.message, true) })
  const [sel, setSel] = useState<Record<string, string>>({})
  if (list.isLoading) return <Loading />
  if (list.error) return <ErrorBox error={list.error} retry={() => list.refetch()} />
  if (!list.data!.length) return <Empty icon="bell" title="No upcoming deadlines" />
  const opts: Record<string, string[]> = { '3d': ['3d'], '1d': ['1d'], both: ['1d', '3d'], none: [] }
  return <Card><div className="list">{list.data!.map(a => { const cur = a.reminders.length === 2 ? 'both' : a.reminders[0] || 'none'; const v = sel[a.id] ?? cur; return <div className="li" key={a.id}>
    <div className="ic warn"><Icon n="bell" /></div><div className="bd"><div className="tt">{a.title}</div><div className="ds">{a.course_code} · due {fmtDate(a.due, true)}{a.reminders.length ? ` · reminders: ${a.reminders.map((r: string) => r === '3d' ? '3 days before' : '1 day before').join(', ')}` : ''}</div></div>
    <select className="inp" style={{ width: 'auto' }} aria-label={`Reminder timing for ${a.title}`} value={v} onChange={e => setSel({ ...sel, [a.id]: e.target.value })}><option value="3d">3 days before</option><option value="1d">1 day before</option><option value="both">Both</option><option value="none">None</option></select>
    <button className="btn sm pri" disabled={m.isPending || v === cur} onClick={() => m.mutate({ id: a.id, when: opts[v] })}>Schedule</button></div> })}</div>
    <p className="xs muted" style={{ marginTop: 8 }}>The schedule is saved with the assessment for the notification service, which reminds only students who haven’t submitted. To remind someone right now, use Grading → Remind.</p></Card>
}
