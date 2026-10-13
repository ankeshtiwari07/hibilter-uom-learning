import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Icon } from '../../components/Icon'
import { Badge, Empty, ErrorBox, Loading, PageHead, Tabs, useToast } from '../../components/ui'
import { get, post } from '../../lib/api'
import { rel } from '../../lib/format'
import { CourseCard, errText } from './shared'
import { ComposeModal, ThreadList, ThreadModal, ThreadRow } from './threads'

type Ann = { id: string; scope: string; title: string; body: string; priority: string; course_id?: string; course_code?: string; faculty?: string; by: string; at: string; unread: boolean }
type Msgs = { threads: ThreadRow[]; recipients: { course_id: string; course_code: string; lecturer: string }[] }

export default function Announcements() {
  const qc = useQueryClient(); const toast = useToast()
  const [sp, setSp] = useSearchParams()
  const tab = sp.get('tab') || 'course'
  const anns = useQuery({ queryKey: ['s-anns'], queryFn: () => get<Ann[]>('/api/student/announcements') })
  const threads = useQuery({ queryKey: ['s-threads'], queryFn: () => get<ThreadRow[]>('/api/student/threads'), enabled: tab === 'disc' })
  const msgs = useQuery({ queryKey: ['s-messages'], queryFn: () => get<Msgs>('/api/student/messages') })
  const courses = useQuery({ queryKey: ['s-courses'], queryFn: () => get<CourseCard[]>('/api/student/courses') })
  const [course, setCourse] = useState('all'); const [unread, setUnread] = useState(false)
  const [openT, setOpenT] = useState<string | null>(null); const [compose, setCompose] = useState<null | 'thread' | 'message'>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const refresh = () => { qc.invalidateQueries({ queryKey: ['s-anns'] }); qc.invalidateQueries({ queryKey: ['notifications'] }); qc.invalidateQueries({ queryKey: ['s-dash'] }) }
  const readAll = useMutation({ mutationFn: () => post<{ count: number }>('/api/student/announcements/read-all'), onSuccess: () => { refresh(); toast('All marked as read') }, onError: (e: any) => toast(errText(e), true) })
  const readOne = useMutation({ mutationFn: (id: string) => post(`/api/student/announcements/${id}/read`), onSuccess: (_r, id) => { qc.setQueryData<Ann[]>(['s-anns'], x => x?.map(a => a.id === id ? { ...a, unread: false } : a)); qc.invalidateQueries({ queryKey: ['notifications'] }) } })
  const list = useMemo(() => (anns.data || []).filter(a => (tab === 'uni' ? a.scope !== 'course' : a.scope === 'course') && (course === 'all' || a.course_id === course) && (!unread || a.unread)), [anns.data, tab, course, unread])
  const count = (k: string) => (anns.data || []).filter(a => a.unread && (k === 'uni' ? a.scope !== 'course' : a.scope === 'course')).length
  const toggle = (a: Ann) => { setExpanded(x => x === a.id ? null : a.id); if (a.unread) readOne.mutate(a.id) }
  const enrolled = (courses.data || []).map(c => ({ id: c.id, label: `${c.code} · ${c.title}` }))
  const filteredThreads = (threads.data || []).filter(t => course === 'all' || t.course_id === course)
  return <>
    <PageHead no={11} title="Announcements & messages" sub="Course announcements, university notices, discussions and messages to your lecturers."
      actions={<><button className="btn" disabled={readAll.isPending} onClick={() => readAll.mutate()}><Icon n="check" />Mark all read</button>
        <button className="btn pri" onClick={() => setCompose('message')} disabled={!msgs.data?.recipients.length && !courses.data?.length}><Icon n="msg" />Message a lecturer</button></>} />
    <Tabs tabs={[['course', `Course announcements${count('course') ? ` (${count('course')})` : ''}`], ['uni', `University notices${count('uni') ? ` (${count('uni')})` : ''}`], ['disc', 'Discussions'], ['msg', 'Messages']]} value={tab} onChange={k => setSp({ tab: k })} />
    {tab !== 'msg' && <div className="filters">{tab !== 'uni' && <div className="field"><label htmlFor="nw-c">Course</label><select id="nw-c" className="inp" value={course} onChange={e => setCourse(e.target.value)}><option value="all">All my courses</option>
      {(courses.data || []).map(c => <option key={c.id} value={c.id}>{c.code}</option>)}</select></div>}
      {tab !== 'disc' && <label className="chk" style={{ marginBottom: 8 }}><input type="checkbox" checked={unread} onChange={e => setUnread(e.target.checked)} />Unread only</label>}
      {tab === 'disc' && <button className="btn" style={{ marginBottom: 2 }} onClick={() => setCompose('thread')} disabled={!enrolled.length}><Icon n="plus" />New thread</button>}</div>}
    {(tab === 'course' || tab === 'uni') && (anns.isLoading ? <Loading /> : anns.error ? <ErrorBox error={anns.error} retry={() => anns.refetch()} />
      : <div className="card">{list.length ? <div className="list">{list.map(n => <div key={n.id} className={`li ${n.unread ? 'unread' : ''}`} style={{ cursor: 'pointer' }} role="button" tabIndex={0} aria-expanded={expanded === n.id}
        onClick={() => toggle(n)} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggle(n))}>
        <div className={`ic ${n.scope === 'course' ? 'teal' : 'gold'}`}><Icon n={n.scope === 'course' ? 'mega' : 'bldg'} /></div>
        <div className="bd"><div className="tt">{n.title}</div><div className="ds" style={expanded === n.id ? { whiteSpace: 'pre-wrap' } : { overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{n.body}</div>
          <div className="xs muted" style={{ marginTop: 3 }}>{n.by} · {n.scope === 'university' ? 'All students' : n.scope === 'faculty' ? `${n.faculty || 'Faculty'} students` : n.course_code} · {rel(n.at)}</div></div>
        {n.priority === 'high' && <Badge kind="bad">Important</Badge>}{n.unread && <Badge kind="teal">New</Badge>}</div>)}</div>
        : <Empty icon="mega" title={unread ? 'No unread announcements' : 'No announcements'}>{unread ? 'You’re all caught up.' : 'Notices will appear here.'}</Empty>}</div>)}
    {tab === 'disc' && (threads.isLoading ? <Loading /> : threads.error ? <ErrorBox error={threads.error} retry={() => threads.refetch()} />
      : <div className="card"><ThreadList rows={filteredThreads} onOpen={setOpenT} empty="No discussions yet — start one." /></div>)}
    {tab === 'msg' && (msgs.isLoading ? <Loading /> : msgs.error ? <ErrorBox error={msgs.error} retry={() => msgs.refetch()} />
      : <div className="card"><ThreadList showWith rows={msgs.data!.threads} onOpen={setOpenT} empty="No messages yet. Use “Message a lecturer” to start one." /></div>)}
    {openT && <ThreadModal id={openT} onClose={() => setOpenT(null)} />}
    {compose && <ComposeModal mode={compose} onClose={() => setCompose(null)} defaultCourse={course !== 'all' ? course : undefined}
      courses={compose === 'message' ? (msgs.data?.recipients || []).map(r => ({ id: r.course_id, label: `${r.lecturer} (${r.course_code})` })) : enrolled} />}
  </>
}
