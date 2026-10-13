/* Discussion thread / message components shared by Course (S04) and Announcements (S11). */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Icon } from '../../components/Icon'
import { Avatar, Badge, Empty, ErrorBox, Field, Loading, Modal, useToast } from '../../components/ui'
import { get, post } from '../../lib/api'
import { rel } from '../../lib/format'
import { errText } from './shared'

export type ThreadRow = { id: string; subject: string; course_id: string; course_code?: string; by?: string; replies: number; last_at: string; last: string
  last_by?: string; answered: boolean; with?: string | null; mine: boolean }

export function ThreadList({ rows, onOpen, empty, showWith }: { rows: ThreadRow[]; onOpen: (id: string) => void; empty: string; showWith?: boolean }) {
  if (!rows.length) return <Empty icon="msg" title={empty} />
  return <div className="list">{rows.map(t => <button key={t.id} className="li" onClick={() => onOpen(t.id)} style={{ background: 'none', border: 0, borderBottom: '1px solid var(--line)', textAlign: 'left', cursor: 'pointer', font: 'inherit', color: 'inherit', width: '100%' }}>
    <div className="ic"><Icon n={showWith ? 'send' : 'msg'} /></div>
    <div className="bd"><div className="tt">{showWith && t.with ? `To ${t.with}: ` : ''}{t.subject}</div>
      <div className="ds">{t.course_code} · {showWith ? '' : `started by ${t.by || 'unknown'} · `}{t.replies} repl{t.replies === 1 ? 'y' : 'ies'} · last {rel(t.last_at)}</div>
      {showWith && <div className="xs" style={{ marginTop: 4, color: t.answered ? 'var(--teal)' : 'var(--muted)' }}>{t.answered ? `Reply from ${t.last_by}` : 'Awaiting reply'}</div>}</div>
    {!showWith && (t.answered ? <Badge kind="good">Lecturer replied</Badge> : <Badge kind="out">Open</Badge>)}
  </button>)}</div>
}

type Detail = { id: string; subject: string; course_code?: string; private: boolean; messages: { id: number; body: string; at: string; by: string; role?: string; mine: boolean }[] }

export function ThreadModal({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient(); const toast = useToast()
  const q = useQuery({ queryKey: ['s-thread', id], queryFn: () => get<Detail>(`/api/student/threads/${id}`) })
  const [body, setBody] = useState(''); const [err, setErr] = useState<string | null>(null)
  const m = useMutation({
    mutationFn: () => post(`/api/student/threads/${id}/messages`, { body: body.trim() }),
    onSuccess: () => { setBody(''); qc.invalidateQueries({ queryKey: ['s-thread', id] }); qc.invalidateQueries({ queryKey: ['s-threads'] }); qc.invalidateQueries({ queryKey: ['s-course'] }); qc.invalidateQueries({ queryKey: ['s-messages'] }); toast('Reply posted') },
    onError: (e: any) => toast(errText(e), true),
  })
  const send = () => { if (!body.trim()) { setErr('Write a reply first.'); return } setErr(null); m.mutate() }
  return <Modal wide title={q.data?.subject || 'Discussion'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Close</button><button className="btn pri" disabled={m.isPending} onClick={send}><Icon n="send" />{m.isPending ? 'Posting…' : 'Post reply'}</button></>}>
    {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} retry={() => q.refetch()} /> : <>
      <div className="row"><Badge kind="out">{q.data!.course_code}</Badge>{q.data!.private ? <Badge kind="info">Private message</Badge> : <Badge kind="out">Course discussion · visible to the class</Badge>}</div>
      <div className="list">{q.data!.messages.map(x => <div className="li" key={x.id}><Avatar name={x.by} kind={x.role === 'student' ? '' : 't'} />
        <div className="bd"><div className="tt">{x.by}{x.role && x.role !== 'student' ? <span className="b teal" style={{ marginLeft: 6 }}>{x.role === 'lecturer' ? 'Lecturer' : 'Staff'}</span> : null}</div>
          <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{x.body}</div><div className="xs muted">{rel(x.at)}</div></div></div>)}</div>
      <Field label="Your reply" htmlFor="th-reply" error={err}><textarea id="th-reply" className="inp" rows={3} maxLength={5000} value={body} onChange={e => setBody(e.target.value)} /></Field>
    </>}
  </Modal>
}

export function ComposeModal({ mode, courses, defaultCourse, onClose }: { mode: 'thread' | 'message'; courses: { id: string; label: string }[]; defaultCourse?: string; onClose: () => void }) {
  const qc = useQueryClient(); const toast = useToast()
  const [f, setF] = useState({ course_id: defaultCourse || courses[0]?.id || '', subject: '', body: '' })
  const [errs, setErrs] = useState<Record<string, string>>({})
  const m = useMutation({
    mutationFn: () => post(mode === 'thread' ? '/api/student/threads' : '/api/student/messages', { ...f, subject: f.subject.trim(), body: f.body.trim() }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['s-threads'] }); qc.invalidateQueries({ queryKey: ['s-messages'] }); qc.invalidateQueries({ queryKey: ['s-course'] }); toast(mode === 'thread' ? 'Thread started' : 'Message sent'); onClose() },
    onError: (e: any) => toast(errText(e), true),
  })
  const submit = () => {
    const e: Record<string, string> = {}
    if (!f.course_id) e.course_id = 'Choose a course.'
    if (f.subject.trim().length < 3) e.subject = 'Add a subject (at least 3 characters).'
    if (f.body.trim().length < 2) e.body = 'Write a message.'
    setErrs(e); if (!Object.keys(e).length) m.mutate()
  }
  return <Modal title={mode === 'thread' ? 'Start a discussion' : 'Message a lecturer'} onClose={onClose}
    footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn pri" disabled={m.isPending} onClick={submit}><Icon n="send" />{m.isPending ? 'Sending…' : mode === 'thread' ? 'Post thread' : 'Send'}</button></>}>
    <Field label={mode === 'thread' ? 'Course' : 'To'} htmlFor="cm-to" error={errs.course_id}><select id="cm-to" className="inp" value={f.course_id} onChange={e => setF({ ...f, course_id: e.target.value })}>
      {courses.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}</select></Field>
    <Field label="Subject" htmlFor="cm-s" error={errs.subject}><input id="cm-s" className="inp" maxLength={200} value={f.subject} onChange={e => setF({ ...f, subject: e.target.value })} /></Field>
    <Field label="Message" htmlFor="cm-b" error={errs.body} hint={mode === 'thread' ? 'Visible to everyone in the course.' : 'Only you and the lecturer can see this.'}>
      <textarea id="cm-b" className="inp" rows={5} maxLength={5000} value={f.body} onChange={e => setF({ ...f, body: e.target.value })} /></Field>
  </Modal>
}
