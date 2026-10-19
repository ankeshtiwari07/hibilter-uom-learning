import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon } from '../../components/Icon'
import { AiTag, Badge, Empty, ErrorBox, Loading, Note, PageHead } from '../../components/ui'
import { get } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { mmss } from './shared'

export default function FacultySelect() {
  const { me } = useAuth()
  return me?.demo && me.role === 'student' ? <StudioClassroom /> : <Interactive />
}

type StudioLecture = { course_id: string; course_code: string; course_title: string; item_id: string; title: string; module: string; status: string
  link: string; duration: number; poster_url: string; chapters: string[]; lecturer: { id: string; name: string; subject: string; portrait: string; style: string } | null }

// Demo mode: the classroom is the lecturers' studio-filmed lectures (the interactive classroom opens once every lecturer is filmed).
function StudioClassroom() {
  const nav = useNavigate()
  const q = useQuery({ queryKey: ['s-studio-lectures'], queryFn: () => get<StudioLecture[]>('/api/student/studio-lectures') })
  if (q.isLoading) return <Loading />
  if (q.error) return <ErrorBox error={q.error} retry={() => q.refetch()} />
  const ls = q.data || []
  return <>
    <PageHead no={30} title="Virtual classroom" sub="Lectures filmed with your digital lecturers. Choose a lecturer to start their lecture, with captions, chapters and a transcript." />
    {!ls.length ? <Empty icon="cap" title="No lectures open yet">Your digital lecturers’ lectures will appear here when they are published.</Empty> : <>
      <div className="vc-grid">{ls.map(l => <article key={l.course_id + l.item_id} className="card vc-card">
        <button className="vc-poster" onClick={() => nav(l.link)} aria-label={`Watch ${l.title} with ${l.lecturer?.name || 'your lecturer'}`}>
          <img src={l.poster_url} alt="" /><span className="vc-play"><Icon n="playc" /></span><span className="vc-dur">{mmss(l.duration)}</span></button>
        <div className="vc-bd">
          {l.lecturer && <div className="vc-who"><img src={l.lecturer.portrait} alt="" /><span><b>{l.lecturer.name}</b><span className="xs muted">{l.lecturer.subject}</span></span></div>}
          <div className="xs muted">{l.course_code} · {l.course_title}</div>
          <h3 className="vc-title">{l.title}</h3>
          {l.chapters.length > 0 && <div className="vc-ch">{l.chapters.map(c => <span key={c} className="studio-chip">{c}</span>)}</div>}
          <div className="row sb" style={{ marginTop: 'auto' }}>
            {l.status === 'done' ? <Badge kind="good">Watched</Badge> : l.status === 'progress' ? <Badge kind="warn">In progress</Badge> : <Badge kind="out">Not started</Badge>}
            <button className="btn teal" onClick={() => nav(l.link)}><Icon n="playc" />{l.status === 'done' ? 'Watch again' : l.status === 'progress' ? 'Resume' : 'Watch lecture'}</button></div>
        </div></article>)}</div>
      <Note>Digital lecturers are AI. The lectures are generated from course material your lecturers approved, and your course lecturer remains responsible for teaching and grades.</Note>
    </>}
  </>
}

function Interactive() {
  const nav = useNavigate(); const { me, setPrefs } = useAuth()
  const lessons = useQuery({ queryKey: ['vf-lessons'], queryFn: () => get<any[]>('/api/vf/lessons') })
  const avatars = useQuery({ queryKey: ['avatars'], queryFn: () => get<any[]>('/api/vf/avatars') })
  const [lessonId, setLessonId] = useState<string>('')
  const [sel, setSel] = useState<string>(me?.prefs?.avatar || '')
  if (lessons.isLoading || avatars.isLoading) return <Loading />
  if (lessons.error) return <ErrorBox error={lessons.error} retry={() => lessons.refetch()} />
  const ls = lessons.data || []
  const lesson = ls.find(l => l.id === lessonId) || ls[0]
  const order: string[] = lesson?.avatars || []
  const allowed = (avatars.data || []).filter(a => !lesson || order.includes(a.id)).sort((x, y) => order.indexOf(x.id) - order.indexOf(y.id))
  const chosen = sel && allowed.some(a => a.id === sel) ? sel : allowed[0]?.id
  return <>
    <PageHead no={30} title="Virtual faculty" sub="Choose your digital lecturer. Every lecturer teaches the same approved lesson, asks the same checkpoint questions, and reports to your human course lecturer."
      actions={lesson && <button className="btn teal lg" onClick={() => { setPrefs({ avatar: chosen }); nav(`/s-classroom/${lesson.id}?avatar=${chosen}`) }}><Icon n="playc" />Enter classroom</button>} />
    {!ls.length ? <Empty icon="cap" title="No interactive lessons open yet">Interactive lessons with your digital lecturers will open here when your lecturers publish them. Meanwhile, watch the lecture videos in <a href="/s-courses">My courses</a>.</Empty> : <>
      <div className="card"><div className="hd"><h3>Lesson</h3><AiTag label="Interactive" /></div>
        <div className="list">{ls.map(l => <label key={l.id} className="li" style={{ cursor: 'pointer' }}>
          <input type="radio" name="lesson" checked={lesson?.id === l.id} onChange={() => setLessonId(l.id)} style={{ accentColor: 'var(--teal)', marginTop: 10 }} />
          <span className="ic teal"><Icon n="cap" /></span>
          <span className="bd"><span className="tt">{l.title}</span><span className="ds" style={{ display: 'block' }}>{l.course_code} · {l.module} · {l.dur} min · {l.checkpoints} checkpoints</span></span>
          {l.my_status === 'completed' ? <Badge kind="good">Completed</Badge> : l.my_status ? <Badge kind="warn">In progress</Badge> : <Badge kind="out">Not started</Badge>}
        </label>)}</div></div>
      <div className="faculty">{allowed.map(a => <button key={a.id} className={`fcard ${a.id === chosen ? 'sel' : ''}`} style={{ textAlign: 'left', cursor: 'pointer', padding: 0 }} onClick={() => setSel(a.id)} aria-pressed={a.id === chosen}>
        <div className="por"><img src={a.portrait} alt={`${a.name}, digital lecturer`} style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: a.calib?.pos }} /></div>
        <div className="bd"><div className="row sb"><b>{a.name}</b>{a.id === chosen && <Badge kind="teal"><Icon n="check" />Selected</Badge>}</div>
          <span className="small muted">{a.subject}</span>
          <dl className="kv"><dt>Voice</dt><dd>{a.voice}</dd><dt>Style</dt><dd>{a.style}</dd></dl></div></button>)}</div>
      <Note>Digital lecturers are AI. They never set official grades; your course lecturer reviews any checkpoint completed with assistance.</Note>
    </>}
  </>
}
