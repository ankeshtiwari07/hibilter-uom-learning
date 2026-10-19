import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon } from '../../components/Icon'
import { AiTag, Badge, Empty, ErrorBox, Loading, Note, PageHead } from '../../components/ui'
import { get } from '../../lib/api'
import { useAuth } from '../../lib/auth'

export default function FacultySelect() {
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
