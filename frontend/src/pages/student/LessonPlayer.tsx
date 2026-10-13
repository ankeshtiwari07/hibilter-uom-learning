import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { Icon } from '../../components/Icon'
import { AiTag, Bar, Card, Empty, ErrorBox, Field, Loading, Note, PageHead, Tabs, useToast } from '../../components/ui'
import { del, get, post } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { rel } from '../../lib/format'
import { AnswerBubble, Pending, Turn, useAsk, useRate } from './assistantUi'
import { Markdown, headings } from '../../components/Markdown'
import { Lecture, LectureData } from './Lecture'
import { errText, itemIcon, mmss } from './shared'

type Line = { t: number; title?: string; sub?: string; text: string }
type NoteRow = { id: number; kind: string; text: string; t?: number | null; at: string }
type NavItem = { id: string; title: string; type: string; link: string }
type Lesson = {
  course: { id: string; code: string; title: string }
  item: { id: string; title: string; type: string; dur?: number; module: string; status: string; pos?: number; index: number }
  media_url?: string | null; body?: string | null; presenter?: string | null; objectives: string[]; transcript: Line[]; chips: string[]; lecture?: LectureData | null
  prev: NavItem | null; next: NavItem | null; notes: NoteRow[]; materials: { id: string; title: string; kind: string; uri?: string | null }[]; related: NavItem[]
}

export default function LessonPlayer() {
  const [sp] = useSearchParams()
  const course = sp.get('course'), item = sp.get('item')
  const nx = useQuery({ queryKey: ['s-lesson-next'], queryFn: () => get<{ course: string; item: string } | null>('/api/student/lessons/next'), enabled: !course || !item })
  if (!course || !item) {
    if (nx.isLoading) return <Loading />
    if (nx.error) return <ErrorBox error={nx.error} retry={() => nx.refetch()} />
    if (!nx.data) return <><PageHead no={5} title="Lesson player" /><Empty icon="play" title="No video or reading lessons yet">When your lecturers publish lessons they’ll play here. <Link to="/s-course">Open my course</Link></Empty></>
    return <Navigate replace to={`/s-lesson?course=${nx.data.course}&item=${nx.data.item}`} />
  }
  return <Player key={`${course}/${item}`} course={course} item={item} />
}

function Player({ course, item }: { course: string; item: string }) {
  const nav = useNavigate(); const toast = useToast(); const qc = useQueryClient(); const { me } = useAuth()
  const key = ['s-lesson', course, item]
  const q = useQuery({ queryKey: key, queryFn: () => get<Lesson>(`/api/student/lessons/${course}/${item}`) })
  const d = q.data
  const total = d?.lecture ? d.lecture.duration : (d?.item.dur || 10) * 60
  const [t, setT] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [cc, setCc] = useState(me?.prefs?.captions !== false)
  const [muted, setMuted] = useState(false)
  const [tab, setTab] = useState('obj')
  const tRef = useRef(0); tRef.current = t
  const opened = useRef(false)

  const progress = useMutation({
    mutationFn: (v: { pos: number; done?: boolean }) => post<{ done: boolean; newly_completed: boolean; course_progress: number }>(`/api/student/lessons/${course}/${item}/progress`, v),
    onSuccess: (r, v) => {
      if (v.done) { toast(r.newly_completed ? `Lesson marked complete · course progress ${r.course_progress}%` : 'Already completed'); qc.invalidateQueries({ queryKey: key }); qc.invalidateQueries({ queryKey: ['s-course'] }); qc.invalidateQueries({ queryKey: ['s-dash'] }) }
    },
    onError: (e: any, v) => v.done && toast(errText(e), true),
  })
  // record that the lesson was opened, restore last position
  useEffect(() => {
    if (!d || opened.current) return
    opened.current = true
    setT(Math.min(d.item.pos || 0, total))
    progress.mutate({ pos: d.item.pos || 0 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d])
  useEffect(() => () => { if (opened.current && tRef.current > 0) post(`/api/student/lessons/${course}/${item}/progress`, { pos: Math.round(tRef.current) }).catch(() => { }) }, [course, item])
  // simulated playback (no media file): 24× speed so the demo is watchable
  useEffect(() => {
    if (!playing || d?.media_url || d?.lecture) return
    const id = setInterval(() => setT(x => { const n = Math.min(total, x + 6); if (n >= total) setPlaying(false); return n }), 250)
    return () => clearInterval(id)
  }, [playing, total, d?.media_url, d?.lecture])
  const togglePlay = () => { if (playing) progress.mutate({ pos: Math.round(t) }); else if (t >= total) setT(0); setPlaying(p => !p) }

  const notes = useMutation({
    mutationFn: (v: { kind: string; text?: string; t?: number }) => post<NoteRow>(`/api/student/lessons/${course}/${item}/notes`, v),
    onSuccess: (n) => { qc.setQueryData<Lesson>(key, x => x ? { ...x, notes: [n, ...x.notes] } : x); toast(n.kind === 'bookmark' ? 'Bookmark added' : 'Note saved') },
    onError: (e: any) => toast(errText(e), true),
  })
  const delNote = useMutation({
    mutationFn: (id: number) => del(`/api/student/notes/${id}`),
    onSuccess: (_r, id) => { qc.setQueryData<Lesson>(key, x => x ? { ...x, notes: x.notes.filter(n => n.id !== id) } : x); toast('Note deleted') },
    onError: (e: any) => toast(errText(e), true),
  })

  if (q.isLoading) return <Loading label="Loading lesson…" />
  if (q.error) return <ErrorBox error={q.error} retry={() => q.refetch()} />
  const L = d!
  const cur = [...L.transcript].reverse().find(l => l.t <= t) || L.transcript[0]
  const done = L.item.status === 'done'
  const isVideo = L.item.type === 'video'
  return <>
    <PageHead no={5} title={L.item.title} sub={`${L.course.code} · ${L.item.module} · Lesson ${L.item.index} · ${L.item.dur ? `${L.item.dur} min ` : ''}${L.item.type}`}
      actions={<>{L.prev ? <button className="btn" onClick={() => nav(L.prev!.link)}><Icon n="back" />Previous: {L.prev.title.length > 28 ? L.prev.title.slice(0, 26) + '…' : L.prev.title}</button>
        : <Link className="btn" to={`/s-course/${L.course.id}`}><Icon n="back" />Course</Link>}
        {L.next && <button className="btn" onClick={() => nav(L.next!.link)}>Next: {L.next.title.length > 28 ? L.next.title.slice(0, 26) + '…' : L.next.title}<Icon n="chev" /></button>}</>} />
    <div className="g g-31"><div className="stack">
      {isVideo && L.lecture ? <Lecture data={L.lecture} title={L.item.title} startAt={L.item.pos || 0} captionsDefault={cc} reducedMotion={!!me?.prefs?.reducedMotion}
        onPosition={(pos, live) => { setT(pos); if (!live) progress.mutate({ pos }); else post(`/api/student/lessons/${course}/${item}/progress`, { pos }).catch(() => { }) }}
        onEnded={() => { if (!done) progress.mutate({ pos: Math.round(total), done: true }) }} />
      : isVideo ? (L.media_url
        ? <video className="player" src={L.media_url} controls preload="metadata" style={{ width: '100%' }} onTimeUpdate={e => setT((e.target as HTMLVideoElement).currentTime)} onPause={() => progress.mutate({ pos: Math.round(t) })} />
        : <div className="player" aria-label="Lesson video (simulated)">
          <div className="scr"><div style={{ textAlign: 'center', maxWidth: '80%' }}>
            <div className="eyebrow" style={{ color: '#7FD8D2' }}>Lecture video · {L.presenter || 'Course lecturer'} (simulated)</div>
            <h2 style={{ color: '#fff', marginTop: 8, fontSize: 26 }}>{cur?.title || L.item.title}</h2>
            {cur?.sub && <p style={{ color: '#B9C7D8', marginTop: 6 }}>{cur.sub}</p>}</div></div>
          {cc && cur && t > 0 && <div className="cap" aria-live="polite">{cur.text}</div>}
          <div className="ctl"><button className="iconbtn" style={{ color: '#fff' }} onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}><Icon n={playing ? 'pause' : 'playc'} /></button>
            <span className="num">{mmss(t)} / {mmss(total)}</span>
            <div className="bar" role="slider" tabIndex={0} aria-label="Seek" aria-valuemin={0} aria-valuemax={total} aria-valuenow={Math.round(t)}
              onClick={e => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setT(Math.round(total * (e.clientX - r.left) / r.width)) }}
              onKeyDown={e => { if (e.key === 'ArrowRight') setT(x => Math.min(total, x + 10)); if (e.key === 'ArrowLeft') setT(x => Math.max(0, x - 10)) }}><i style={{ width: `${(t / total) * 100}%` }} /></div>
            <button className="iconbtn" style={{ color: cc ? '#7FD8D2' : '#fff' }} onClick={() => setCc(x => !x)} aria-pressed={cc} aria-label="Captions"><Icon n="cc" /></button>
            <button className="iconbtn" style={{ color: '#fff' }} onClick={() => setMuted(x => !x)} aria-pressed={muted} aria-label={muted ? 'Unmute' : 'Mute'}><Icon n={muted ? 'mute' : 'vol'} /></button></div>
        </div>)
        : <Card title={<><Icon n={itemIcon[L.item.type] || 'book'} /> Reading</>} actions={L.body ? <span className="xs muted">{L.item.dur} min read</span> : undefined}>{L.body ? <>
          {headings(L.body).length > 2 && <nav className="md-toc" aria-label="In this reading"><span className="eyebrow">In this reading</span>{headings(L.body).map(h => <a key={h.id} href={`#${h.id}`} onClick={e => { e.preventDefault(); document.getElementById(h.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }}>{h.text}</a>)}</nav>}
          <Markdown src={L.body} /></>
          : <Note>The reading for this lesson is provided under <b>Materials</b> below. Mark it complete when you’ve finished.</Note>}</Card>}
      <div className="row">
        <button className={`btn ${done ? 'teal' : ''}`} disabled={done || progress.isPending} onClick={() => progress.mutate({ pos: Math.round(t), done: true })}><Icon n={done ? 'checkc' : 'check'} />{done ? 'Completed' : 'Mark as complete'}</button>
        {isVideo && <button className="btn ghost" disabled={notes.isPending} onClick={() => notes.mutate({ kind: 'bookmark', t: Math.round(t) })}><Icon n="bookmark" />Bookmark at {mmss(t)}</button>}
        <span className="sp" />{isVideo && !L.media_url && !L.lecture && <span className="xs muted">Video playback is simulated in this prototype</span>}</div>
      <div className="card"><div className="hd"><Tabs tabs={[['obj', 'Objectives'], ['tr', 'Transcript'], ['notes', `My notes (${L.notes.length})`], ['res', 'Materials']]} value={tab} onChange={setTab} /></div>
        {tab === 'obj' ? (L.objectives.length ? <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{L.objectives.map(o => <li key={o}>{o}</li>)}</ul> : <p className="small muted">Objectives haven’t been published for this lesson.</p>)
          : tab === 'tr' ? (L.transcript.length ? <div className="transcript" style={{ maxHeight: 'none' }}>{L.transcript.map((l, i) => <div className="ln" key={i}>
            <button className="link-btn" onClick={() => !L.lecture && setT(l.t)} aria-label={`Jump to ${mmss(l.t)}`}><b>{mmss(l.t)}</b></button><span>{l.text}</span></div>)}</div>
            : <Empty icon="cc" title="Transcript not available">Captions and a transcript haven’t been published for this lesson yet.</Empty>)
            : tab === 'notes' ? <NotesTab notes={L.notes} pending={notes.isPending} onAdd={text => notes.mutate({ kind: 'note', text, t: Math.round(t) })} onDelete={id => delNote.mutate(id)} onJump={setT} />
              : (L.materials.length ? <div className="list">{L.materials.map(m => <div className="li" key={m.id}><div className="ic"><Icon n="file" /></div><div className="bd"><div className="tt">{m.title}</div><div className="ds">Approved course material</div></div>
                {m.uri ? <a className="btn sm" href={m.uri} target="_blank" rel="noreferrer"><Icon n="download" />Open</a> : <span className="xs muted">Available to the assistant</span>}</div>)}</div>
                : <Empty icon="file" title="No materials yet" />)}
      </div>
    </div>
      <div className="stack"><LessonAsk course={L.course} chips={L.chips} first={me?.first || ''} />
        <Card title="Related">{L.related.length ? <div className="list">{L.related.map(r => <a key={r.id} className="li" href={r.link} onClick={e => { e.preventDefault(); nav(r.link) }} style={{ color: 'inherit', textDecoration: 'none' }}>
          <div className="ic"><Icon n={itemIcon[r.type] || 'file'} /></div><div className="bd"><div className="tt">{r.title}</div></div></a>)}</div> : <p className="small muted">Nothing related yet.</p>}</Card>
        <Card title="Lesson progress"><Bar v={done ? 100 : Math.round((t / total) * 100)} /><p className="xs muted" style={{ marginTop: 6 }}>{done ? 'You’ve completed this lesson.' : isVideo ? `Watched to ${mmss(t)} of ${mmss(total)} — your position is saved when you pause or leave.` : 'Mark the reading complete when you’ve finished.'}</p></Card>
      </div></div>
  </>
}

function NotesTab({ notes, pending, onAdd, onDelete, onJump }: { notes: NoteRow[]; pending: boolean; onAdd: (t: string) => void; onDelete: (id: number) => void; onJump: (t: number) => void }) {
  const [v, setV] = useState(''); const [err, setErr] = useState<string | null>(null)
  return <>
    <Field label="New note" htmlFor="lp-note" error={err}><textarea className="inp" id="lp-note" rows={3} maxLength={2000} placeholder="Write a note for this lesson…" value={v} onChange={e => setV(e.target.value)} /></Field>
    <div className="row" style={{ marginTop: 8 }}><button className="btn sm pri" disabled={pending} onClick={() => { if (!v.trim()) { setErr('Write something first.'); return } setErr(null); onAdd(v.trim()); setV('') }}>Save note</button><span className="xs muted">Notes are private to you.</span></div>
    {notes.length ? <div className="list">{notes.map(n => <div className="li" key={n.id}><div className="ic"><Icon n={n.kind === 'bookmark' ? 'bookmark' : 'note'} /></div>
      <div className="bd small"><div style={{ whiteSpace: 'pre-wrap' }}>{n.text}</div><div className="xs muted">{n.t != null && <button className="link-btn" onClick={() => onJump(n.t!)}>{mmss(n.t)}</button>} · {rel(n.at)}</div></div>
      <button className="iconbtn" aria-label="Delete note" onClick={() => onDelete(n.id)}><Icon n="x" /></button></div>)}</div>
      : <p className="xs muted" style={{ marginTop: 8 }}>No notes yet.</p>}
  </>
}

function LessonAsk({ course, chips, first }: { course: { id: string; code: string }; chips: string[]; first: string }) {
  const [turns, setTurns] = useState<Turn[]>([]); const [v, setV] = useState(''); const [pending, setPending] = useState<string | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const { ratings, rate } = useRate()
  const ask = useAsk(t => { setTurns(x => [...x, t]); setPending(null) })
  useEffect(() => { box.current?.scrollTo({ top: box.current.scrollHeight }) }, [turns, pending])
  const send = (q: string) => { q = q.trim(); if (!q || ask.isPending) return; setPending(q); setV(''); ask.mutate({ course_id: course.id, q }, { onError: () => setPending(null) }) }
  return <div className="ia"><div className="iah"><h3>Ask about this lesson</h3><AiTag /></div><div className="iab">
    <div className="chat" ref={box} style={{ maxHeight: 360, overflow: 'auto' }}><div className="msg ai"><div className="bub small">Hi {first} — I can explain anything in this lesson, using only the approved {course.code} material.</div></div>
      {turns.map(t => <div key={t.id} style={{ display: 'contents' }}><div className="msg me"><div className="bub">{t.question}</div></div><AnswerBubble t={t} rating={ratings[t.id] ?? t.rating} onRate={r => rate(t.id, r)} /></div>)}
      {pending && <Pending q={pending} />}</div>
    <div className="chips">{chips.map(c => <button key={c} className="chip" disabled={ask.isPending} onClick={() => send(c)}>{c}</button>)}</div>
    <form className="row" style={{ flexWrap: 'nowrap' }} onSubmit={e => { e.preventDefault(); send(v) }}><input className="inp" aria-label="Ask a question" placeholder="Ask a question…" maxLength={2000} value={v} onChange={e => setV(e.target.value)} />
      <button className="btn teal" disabled={ask.isPending || !v.trim()} aria-label="Send"><Icon n="send" /></button></form></div></div>
}
