import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Icon } from '../../components/Icon'
import { AiTag, Card, Empty, ErrorBox, Loading, Note, PageHead } from '../../components/ui'
import { get } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { rel } from '../../lib/format'
import { AnswerBubble, Pending, Turn, useAsk, useRate } from './assistantUi'

type Courses = { live: boolean; courses: { id: string; code: string; title: string; sources: { id: string; title: string; kind: string }[] }[] }
const MODES: [string, string][] = [['lesson', 'Ask about the course'], ['simple', 'Explain more simply'], ['summ', 'Summarise'], ['rev', 'Revision questions'], ['quiz', 'Practice quiz']]
const SUGG = ['What’s the difference between AI and ML?', 'Explain overfitting simply', 'Why do we keep a test set?', 'Give me revision questions on labels', 'Who won the 2026 football World Cup?']

export default function Assistant() {
  const { me } = useAuth(); const qc = useQueryClient()
  const [sp, setSp] = useSearchParams()
  const cq = useQuery({ queryKey: ['s-ai-courses'], queryFn: () => get<Courses>('/api/student/assistant/courses') })
  const courseId = sp.get('course') || cq.data?.courses[0]?.id || ''
  const hq = useQuery({ queryKey: ['s-ai-history', courseId], queryFn: () => get<Turn[]>(`/api/student/assistant/history?course_id=${courseId}`), enabled: !!courseId })
  const [mode, setMode] = useState('lesson'); const [v, setV] = useState(sp.get('q') || ''); const [pending, setPending] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const since = useRef(new Date(Date.now() - 5000).toISOString())
  const { ratings, rate } = useRate()
  const ask = useAsk(t => { qc.setQueryData<Turn[]>(['s-ai-history', t.course_id], x => [...(x || []), t]); setPending(null) })
  useEffect(() => { box.current?.scrollTo({ top: box.current.scrollHeight }) }, [hq.data, pending])
  const send = (q: string) => {
    q = q.trim()
    if (!q) { setErr('Type a question first.'); return }
    if (q.length > 2000) { setErr('Keep questions under 2,000 characters.'); return }
    if (ask.isPending || !courseId) return
    setErr(null); setPending(q); setV('')
    ask.mutate({ course_id: courseId, q, mode }, { onError: () => { setPending(null); setV(q) } })
  }
  if (cq.isLoading) return <Loading />
  if (cq.error) return <ErrorBox error={cq.error} retry={() => cq.refetch()} />
  const courses = cq.data!.courses
  const course = courses.find(c => c.id === courseId)
  if (!courses.length) return <><PageHead no={6} title="AI study assistant" /><Empty icon="ai" title="Enrol in a course to use the assistant"><Link to="/s-catalogue">Browse the catalogue</Link></Empty></>
  // privacy choice: hide stored history and show only this visit's conversation
  const turns = (hq.data || []).filter(t => me?.prefs?.privacy?.assistant_history !== false || t.at >= since.current)
  return <>
    <PageHead no={6} title="AI study assistant" sub={`Ask questions, get simpler explanations, summaries and practice questions — grounded in approved ${course?.code || ''} material, with sources.`} />
    <div className="g g-31">
      <div className="ia" style={{ minHeight: 520 }}>
        <div className="iah" style={{ flexWrap: 'wrap' }}><h3>Conversation</h3><AiTag label="AI-generated responses" />
          <select className="inp" aria-label="Course" style={{ width: 'auto', maxWidth: '100%' }} value={courseId} onChange={e => setSp({ course: e.target.value })}>{courses.map(c => <option key={c.id} value={c.id}>{c.code} · {c.title}</option>)}</select>
          <select className="inp" aria-label="Mode" style={{ width: 'auto' }} value={mode} onChange={e => setMode(e.target.value)}>{MODES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
        <div className="iab" style={{ flex: 1 }}>
          <div className="chat" ref={box} style={{ flex: 1, overflow: 'auto', maxHeight: 460 }} aria-live="polite">
            <div className="msg ai"><div className="bub">Hello {me?.first}. I answer from {course?.code}’s approved material and show where each answer comes from. If something isn’t covered, I’ll say so rather than guess. I won’t answer graded assessment questions.</div></div>
            {hq.isLoading ? <Loading label="Loading your conversation…" /> : hq.error ? <ErrorBox error={hq.error} retry={() => hq.refetch()} />
              : turns.map(t => <div key={t.id} style={{ display: 'contents' }}><div className="msg me"><div className="bub">{t.question}<div className="xs" style={{ opacity: .7, marginTop: 2 }}>{rel(t.at)}</div></div></div>
                <AnswerBubble t={t} rating={ratings[t.id] !== undefined ? ratings[t.id] : t.rating} onRate={r => rate(t.id, r)} /></div>)}
            {pending && <Pending q={pending} />}
          </div>
          <div className="chips">{SUGG.map(s => <button key={s} className="chip" disabled={ask.isPending} onClick={() => send(s)}>{s}</button>)}</div>
          <form className="row" style={{ flexWrap: 'nowrap' }} onSubmit={e => { e.preventDefault(); send(v) }}>
            <input className="inp" aria-label="Message" aria-invalid={!!err} placeholder={`Ask about ${course?.code || 'your course'}…`} maxLength={2000} value={v} onChange={e => { setV(e.target.value); setErr(null) }} />
            <button className="btn teal" disabled={ask.isPending}><Icon n="send" />{ask.isPending ? 'Thinking…' : 'Send'}</button></form>
          {err && <span className="err small" style={{ color: 'var(--bad)' }}><Icon n="alert" /> {err}</span>}
        </div>
      </div>
      <div className="stack">
        <Card title="Approved sources">{course?.sources.length ? <div className="list">{course.sources.map(s => <div className="li" key={s.id}><div className="ic"><Icon n="file" /></div>
          <div className="bd"><div className="tt small">{s.title}</div><div className="ds">Approved by course lecturer · {s.kind}</div></div></div>)}</div>
          : <Empty icon="file" title="No approved sources yet">The assistant will say it can’t find an answer until your lecturer approves material for this course.</Empty>}</Card>
        <Note icon="shield">Answers are AI-generated and may contain mistakes. Check them against the cited source. The assistant never submits work, answers graded assessment questions or affects grades. Rate answers to help the course team.</Note>
        <div className="card small"><b>How this works</b><p className="muted" style={{ marginTop: 4 }}>{cq.data!.live
          ? 'Live: Claude answers using only the approved passages retrieved for your question, and cites them.'
          : 'Offline mode: the assistant quotes the best-matching passage from the approved material; anything not covered is reported as not found.'}</p>
          <p className="xs muted" style={{ marginTop: 6 }}>Your questions are stored with your account so you can see your history. The assistant doesn’t use past conversations as memory.</p></div>
      </div>
    </div>
  </>
}
