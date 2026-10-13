import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Icon } from '../../components/Icon'
import { Badge, Bar, Card, Empty, ErrorBox, Kpi, Loading, Modal, Note, PageHead, useToast } from '../../components/ui'
import { get, post, put } from '../../lib/api'
import { fmtDate } from '../../lib/format'
import { DueBadge, StatusBadge, errText, mmss, rid } from './shared'

type Q = { i: number; q: string; o: string[] }
type Review = { q: string; o: string[]; your?: number | null; a?: number; ex?: string; ok: boolean }
type Result = { attempt: number; score: number | null; max: number; correct: number | null; total: number; pct: number | null; submitted_at: string; late: boolean; minutes?: number; auto: boolean; review?: Review[] }
type Summary = { id: string; title: string; course_code: string; course_title: string; due?: string; weight: number; max: number; questions: number; time_limit?: number | null
  attempts_allowed: number; attempts_used: number; in_progress: boolean; closed: boolean; best?: { score: number; pct: number } | null; can_start: boolean; status: string }
type Detail = Summary & { instructions: string; results: Result[]; attempt: null | { n: number; questions: Q[]; answers: Record<string, number>; flags: number[]; deadline?: string | null; remaining?: number | null; saved_at?: string } }

export default function Quiz() {
  const [sp] = useSearchParams()
  const id = sp.get('id')
  return id ? <QuizView key={id} id={id} /> : <QuizList />
}

function QuizList() {
  const q = useQuery({ queryKey: ['s-quizzes'], queryFn: () => get<Summary[]>('/api/student/quizzes') })
  return <>
    <PageHead no={8} title="Quizzes" sub="Timed multiple-choice quizzes from your courses. Your answers are saved as you go." />
    {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} retry={() => q.refetch()} /> : !q.data!.length ? <Empty icon="checkc" title="No quizzes yet">Quizzes from your enrolled courses will appear here.</Empty>
      : <div className="card pad0"><div className="tbl-wrap" style={{ border: 0 }}><table className="t"><thead><tr><th>Quiz</th><th>Closes</th><th>Attempts</th><th>Best</th><th>Status</th><th /></tr></thead>
        <tbody>{q.data!.map(z => <tr key={z.id}><td><b>{z.title}</b><div className="xs muted">{z.course_code} · {z.questions} questions{z.time_limit ? ` · ${z.time_limit} min` : ''} · {z.weight}%</div></td>
          <td className="small">{z.due ? <>{fmtDate(z.due, true)}<div><DueBadge due={z.due} /></div></> : '—'}</td><td className="small num">{z.attempts_used}/{z.attempts_allowed}</td>
          <td className="small num">{z.best ? `${z.best.score}/${z.max} (${z.best.pct}%)` : '—'}</td><td><StatusBadge s={z.status} /></td>
          <td><Link className={`btn sm ${z.in_progress || (z.can_start && !z.attempts_used) ? 'teal' : ''}`} to={`/s-quiz?id=${z.id}`}>{z.in_progress ? 'Resume' : z.attempts_used ? 'Results' : z.can_start ? 'Start' : 'View'}</Link></td></tr>)}</tbody></table></div></div>}
  </>
}

function QuizView({ id }: { id: string }) {
  const qc = useQueryClient(); const toast = useToast()
  const key = ['s-quiz', id]
  const q = useQuery({ queryKey: key, queryFn: () => get<Detail>(`/api/student/quizzes/${id}`) })
  const [practice, setPractice] = useState(false)
  const start = useMutation({ mutationFn: () => post<Detail>(`/api/student/quizzes/${id}/start`), onSuccess: d => qc.setQueryData(key, d), onError: (e: any) => toast(errText(e), true) })
  if (q.isLoading) return <Loading label="Loading quiz…" />
  if (q.error) return <ErrorBox error={q.error} retry={() => q.refetch()} />
  const d = q.data!
  if (d.attempt) return <TakeQuiz d={d} onDone={r => { qc.invalidateQueries({ queryKey: key }); qc.invalidateQueries({ queryKey: ['s-quizzes'] }); qc.invalidateQueries({ queryKey: ['s-dash'] }); qc.invalidateQueries({ queryKey: ['s-progress'] }); toast(`Quiz submitted · ${r.correct}/${r.total} correct`) }} />
  if (practice) return <Practice d={d} onExit={() => setPractice(false)} />
  const shown = d.results.filter(r => r.pct != null)
  const last = shown[shown.length - 1]
  const startBtn = d.can_start && <button className="btn teal" disabled={start.isPending} onClick={() => start.mutate()}><Icon n="playc" />{start.isPending ? 'Starting…' : d.attempts_used ? `Start attempt ${d.attempts_used + 1} of ${d.attempts_allowed}` : 'Start quiz'}</button>
  if (!last) return <>
    <PageHead no={8} title={d.title} sub={`${d.course_code} · ${d.questions} questions${d.time_limit ? ` · ${d.time_limit} minutes` : ''} · counts ${d.weight}%`} actions={<Link className="btn" to="/s-quiz"><Icon n="back" />All quizzes</Link>} />
    <Card title="Before you start">
      <dl className="kv"><dt>Closes</dt><dd>{d.due ? <>{fmtDate(d.due, true)} <DueBadge due={d.due} /></> : 'No deadline'}</dd><dt>Time limit</dt><dd>{d.time_limit ? `${d.time_limit} minutes from when you start — the timer keeps running if you leave` : 'None'}</dd>
        <dt>Attempts</dt><dd>{d.attempts_used} of {d.attempts_allowed} used</dd><dt>Marks</dt><dd>{d.max} · {d.weight}% of {d.course_code}</dd></dl>
      {d.attempts_used > 0 && <Note kind="warn">Your submitted attempt is being reviewed by your lecturer. The mark appears here once it’s published.</Note>}
      {d.instructions && <p className="small" style={{ marginTop: 10, whiteSpace: 'pre-wrap' }}>{d.instructions}</p>}
      <Note>Answers save automatically. When time runs out, your saved answers are submitted for you. Marks are calculated by the system from your lecturer’s answer key.</Note>
      <div className="row" style={{ marginTop: 12 }}>{startBtn || <Badge kind="out">{d.closed ? 'This quiz has closed' : d.questions ? 'No attempts left' : 'No questions published yet'}</Badge>}</div>
    </Card></>
  return <>
    <PageHead no={8} title={`${d.title} — results`} sub={`${d.course_title} · ${d.course_code}`}
      actions={<><Link className="btn" to="/s-progress"><Icon n="line" />View progress</Link>{last.review && <button className="btn" onClick={() => setPractice(true)}>Retake (practice)</button>}{startBtn}</>} />
    <div className="g g3">
      <Kpi label="Score" value={`${last.correct} / ${last.total}`} delta={`${last.pct}% · ${last.score}/${last.max} marks`} />
      <Kpi label="Time taken" value={last.minutes != null ? `${Math.max(1, Math.round(last.minutes))} min` : '—'} delta={d.time_limit ? `of ${d.time_limit} min allowed${last.auto ? ' · submitted when time ran out' : ''}` : undefined} />
      <Kpi label="Contributes" value={`${d.weight}%`} delta={`of ${d.course_code} final mark · best of ${d.attempts_used} attempt${d.attempts_used === 1 ? '' : 's'}`} />
    </div>
    {shown.length > 1 && <Card title="Attempts"><div className="list">{shown.map(r => <div className="li" key={r.attempt}><div className="ic"><Icon n="checkc" /></div><div className="bd"><div className="tt">Attempt {r.attempt}</div><div className="ds">{fmtDate(r.submitted_at, true)}{r.late ? ' · late' : ''}</div></div><b className="num">{r.correct}/{r.total}</b></div>)}</div></Card>}
    {last.review ? <ReviewList review={last.review} note="Correct answers shown because your lecturer allows review after submission" />
      : <Note>Your lecturer hasn’t enabled answer review for this quiz.</Note>}
  </>
}

function ReviewList({ review, note }: { review: Review[]; note: string }) {
  return <Card title="Review" actions={<span className="xs muted">{note}</span>}><div className="col">{review.map((r, i) => <div className="card flat" key={i}>
    <div className="row sb" style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}><b className="small">{i + 1}. {r.q}</b><Badge kind={r.ok ? 'good' : 'bad'}>{r.ok ? 'Correct' : 'Incorrect'}</Badge></div>
    <div className="small" style={{ marginTop: 6 }}>Your answer: {r.your == null ? <i>none</i> : r.o[r.your]}{!r.ok && r.a != null && <><br />Correct answer: <b>{r.o[r.a]}</b></>}</div>
    {r.ex && <div className="xs muted" style={{ marginTop: 4 }}>{r.ex}</div>}</div>)}</div></Card>
}

function Question({ qs, i, ans, flags, onPick, onFlag }: { qs: Q[]; i: number; ans: Record<string, number>; flags: number[]; onPick: (k: number) => void; onFlag?: () => void }) {
  const q = qs[i]
  return <>
    <div className="row sb"><span className="eyebrow">Question {i + 1} of {qs.length}</span>{onFlag && <button className="btn sm ghost" onClick={onFlag} aria-pressed={flags.includes(i)}><Icon n="flag" />{flags.includes(i) ? 'Flagged' : 'Flag for review'}</button>}</div>
    <h2 style={{ margin: '10px 0 16px', fontFamily: 'var(--f-body)', fontSize: 18 }}>{q.q}</h2>
    <div className="col" role="radiogroup" aria-label={`Question ${i + 1}`}>{q.o.map((o, k) => <div key={k} className={`qopt ${ans[String(i)] === k ? 'on' : ''}`} role="radio" tabIndex={0} aria-checked={ans[String(i)] === k}
      onClick={() => onPick(k)} onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onPick(k))}><span className="k">{'ABCDEFGH'[k]}</span><span>{o}</span></div>)}</div>
  </>
}

function Navigator({ n, i, ans, flags, go }: { n: number; i: number; ans: Record<string, number>; flags: number[]; go: (k: number) => void }) {
  const answered = Object.keys(ans).length
  return <><div className="hd"><h3>Questions</h3><span className="xs muted">{answered}/{n} answered</span></div><Bar v={answered / n * 100} />
    <div className="qnav" style={{ marginTop: 12 }}>{Array.from({ length: n }, (_, k) => <button key={k} className={`${ans[String(k)] != null ? 'ans' : ''} ${k === i ? 'cur' : ''} ${flags.includes(k) ? 'flag' : ''}`} onClick={() => go(k)} aria-label={`Question ${k + 1}${ans[String(k)] != null ? ', answered' : ''}${flags.includes(k) ? ', flagged' : ''}`}>{k + 1}</button>)}</div>
    <div className="legend" style={{ marginTop: 12 }}><span><i style={{ background: 'var(--navy)' }} />Answered</span><span><i style={{ border: '1px solid var(--warn)' }} />Flagged</span></div></>
}

function TakeQuiz({ d, onDone }: { d: Detail; onDone: (r: Result) => void }) {
  const A = d.attempt!
  const toast = useToast(); const qc = useQueryClient()
  const [i, setI] = useState(0)
  const [ans, setAns] = useState<Record<string, number>>(A.answers || {})
  const [flags, setFlags] = useState<number[]>(A.flags || [])
  const [confirm, setConfirm] = useState(false)
  const [saveState, setSaveState] = useState<{ at?: string; failed?: boolean }>({ at: A.saved_at })
  const endAt = useRef(A.remaining != null ? Date.now() + A.remaining * 1000 : null)
  const [left, setLeft] = useState<number | null>(A.remaining ?? null)
  const idem = useRef(rid())
  const dirty = useRef(false)
  const latest = useRef({ ans, flags }); latest.current = { ans, flags }

  const save = useCallback(async () => {
    if (!dirty.current) return
    dirty.current = false
    try { const r = await put<{ saved_at: string }>(`/api/student/quizzes/${d.id}/draft`, { answers: latest.current.ans, flags: latest.current.flags }); setSaveState({ at: r.saved_at }) }
    catch (e: any) {
      if (e?.status === 409) { toast(errText(e), true); qc.invalidateQueries({ queryKey: ['s-quiz', d.id] }); return }
      dirty.current = true; setSaveState(s => ({ ...s, failed: true }))
    }
  }, [d.id, qc, toast])
  useEffect(() => { const t = setTimeout(save, 1200); return () => clearTimeout(t) }, [ans, flags, save])
  useEffect(() => { const t = setInterval(() => { if (dirty.current) save() }, 10000); return () => clearInterval(t) }, [save])

  const submit = useMutation({
    mutationFn: () => post<Result>(`/api/student/quizzes/${d.id}/submit`, { answers: latest.current.ans, flags: latest.current.flags, idem: idem.current }),
    onSuccess: r => { setConfirm(false); onDone(r) },
    onError: (e: any) => toast(errText(e), true),
  })
  const fired = useRef(false)
  const submitRef = useRef(() => { }); submitRef.current = () => submit.mutate()
  useEffect(() => {
    if (endAt.current == null) return
    const t = setInterval(() => {
      const s = Math.max(0, Math.round((endAt.current! - Date.now()) / 1000)); setLeft(s)
      if (s === 0 && !fired.current) { fired.current = true; clearInterval(t); toast('Time is up — submitting your answers'); submitRef.current() }
    }, 1000)
    return () => clearInterval(t)
  }, [toast])

  const pick = (k: number) => { dirty.current = true; setAns(a => ({ ...a, [String(i)]: k })) }
  const flag = () => { dirty.current = true; setFlags(f => f.includes(i) ? f.filter(x => x !== i) : [...f, i]) }
  const n = A.questions.length
  const un = n - Object.keys(ans).length
  return <>
    <PageHead no={8} title={d.title} sub={`${d.course_code} · ${n} questions${d.time_limit ? ` · ${d.time_limit} minutes` : ''} · counts ${d.weight}% · attempt ${A.n} of ${d.attempts_allowed}`}
      actions={left != null && <span className={`b ${left < 120 ? 'bad' : 'warn'}`} role="timer" aria-live={left < 60 ? 'assertive' : 'off'}><Icon n="clock" /> {mmss(left)} left</span>} />
    {saveState.failed && <Note kind="warn" icon="wifioff">Autosave failed — your answers are kept on this page and we’ll retry. <button className="btn sm" onClick={() => { dirty.current = true; save() }}>Retry now</button></Note>}
    <div className="g g-31"><div className="card"><Question qs={A.questions} i={i} ans={ans} flags={flags} onPick={pick} onFlag={flag} />
      <div className="row" style={{ marginTop: 18 }}><button className="btn" disabled={!i} onClick={() => setI(i - 1)}><Icon n="back" />Previous</button><span className="sp" />
        <button className="btn" onClick={() => { dirty.current = true; save().then(() => toast('Progress saved — you can return before the quiz closes')) }}><Icon n="save" />Save progress</button>
        {i < n - 1 ? <button className="btn pri" onClick={() => setI(i + 1)}>Next<Icon n="chev" /></button> : <button className="btn teal" onClick={() => setConfirm(true)}>Submit quiz</button>}</div></div>
      <div className="card"><Navigator n={n} i={i} ans={ans} flags={flags} go={setI} />
        <button className="btn teal block" style={{ marginTop: 14 }} onClick={() => setConfirm(true)}>Submit quiz</button>
        <p className="xs muted" style={{ marginTop: 8 }}>{saveState.at ? `Saved ${new Date(saveState.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : 'Not saved yet'}</p></div></div>
    {confirm && <Modal title="Submit quiz?" onClose={() => setConfirm(false)} footer={<><button className="btn" onClick={() => setConfirm(false)}>Keep working</button>
      <button className="btn teal" disabled={submit.isPending} onClick={() => submit.mutate()}>{submit.isPending ? 'Submitting…' : 'Submit now'}</button></>}>
      <p>You have answered <b>{n - un} of {n}</b> questions.{un ? <> <b>{un} unanswered</b> will score zero.</> : null}{flags.length ? ` ${flags.length} flagged for review.` : ''}</p>
      <p className="small muted">You can’t change answers after submitting.</p></Modal>}
  </>
}

function Practice({ d, onExit }: { d: Detail; onExit: () => void }) {
  const toast = useToast()
  const qs = useQuery({ queryKey: ['s-quiz-q', d.id], queryFn: () => get<Q[]>(`/api/student/quizzes/${d.id}/questions`) })
  const [i, setI] = useState(0); const [ans, setAns] = useState<Record<string, number>>({})
  const [res, setRes] = useState<{ correct: number; total: number; pct: number; review: Review[] } | null>(null)
  const m = useMutation({ mutationFn: () => post<any>(`/api/student/quizzes/${d.id}/practice`, { answers: ans }), onSuccess: r => { setRes(r); toast(`Practice score ${r.correct}/${r.total} (not recorded)`) }, onError: (e: any) => toast(errText(e), true) })
  if (qs.isLoading) return <Loading />
  if (qs.error) return <ErrorBox error={qs.error} retry={() => qs.refetch()} />
  const Q = qs.data!
  if (res) return <><PageHead no={8} title={`${d.title} — practice result`} sub="Practice attempts are not recorded and don’t affect your mark." actions={<><button className="btn" onClick={() => { setRes(null); setAns({}); setI(0) }}>Try again</button><button className="btn pri" onClick={onExit}>Back to results</button></>} />
    <div className="g g3"><Kpi label="Practice score" value={`${res.correct} / ${res.total}`} delta={`${res.pct}%`} /></div><ReviewList review={res.review} note="Practice — not recorded" /></>
  return <>
    <PageHead no={8} title={d.title} sub={`${d.course_code} · practice retake (not recorded)`} actions={<button className="btn" onClick={onExit}><Icon n="back" />Back to results</button>} />
    <div className="g g-31"><div className="card"><Question qs={Q} i={i} ans={ans} flags={[]} onPick={k => setAns(a => ({ ...a, [String(i)]: k }))} />
      <div className="row" style={{ marginTop: 18 }}><button className="btn" disabled={!i} onClick={() => setI(i - 1)}><Icon n="back" />Previous</button><span className="sp" />
        {i < Q.length - 1 ? <button className="btn pri" onClick={() => setI(i + 1)}>Next<Icon n="chev" /></button> : <button className="btn teal" disabled={m.isPending} onClick={() => m.mutate()}>Check answers</button>}</div></div>
      <div className="card"><Navigator n={Q.length} i={i} ans={ans} flags={[]} go={setI} /><button className="btn teal block" style={{ marginTop: 14 }} disabled={m.isPending} onClick={() => m.mutate()}>Check answers</button></div></div>
  </>
}
