import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Icon } from '../components/Icon'
import { AiTag, Avatar, Badge, ErrorBox, Loading, Modal, Switch, useToast } from '../components/ui'
import { ApiError, get, post } from '../lib/api'
import { useAuth } from '../lib/auth'
import { AvatarInfo, mountAvatar, Rig } from './avatar'
import { Slide } from './Slides'
import { Voice } from './voice'

type SayItem = { id: string; text: string; kind: string; idx?: number }
type Snap = {
  id: string; version: number; state: string; state_label: string; resume_state?: string | null; seg: number; seg_count: number; sent: number
  status: string; avatar_id: string; trace: string[]; outcome: Record<string, string>; hints: Record<string, number>
  checkpoint: { id: string; question: string; mandatory: boolean; max_attempts: number; attempts: number; hint_count: number } | null
  last_result: { verdict: string; found: string[]; missing: string[]; mis: string[]; engine: string; confidence: string; ai_feedback?: string; answer: string; n: number } | null
  can_continue: boolean; can_assist: boolean; pending_answer?: string | null; model_answer?: string | null
  say: SayItem[]; result?: any; error?: { code?: string; msg: string; field?: string }; assist?: { kind: string; text: string; level?: number; of?: number }; blocked?: string
}
type Line = { who: string; text: string; k?: string }
const AUTO: Record<string, string> = { WELCOME: 'welcomed', TEACHING: 'taught', QUESTION: 'asked', FEEDBACK: 'feedback_done' }
const LIVE: Record<string, string> = { WAITING_FOR_ANSWER: 'wait', EVALUATING: 'eval', ERROR_RECOVERY: 'err', PAUSED: 'pause' }
const VERDICT: Record<string, [string, string]> = { correct: ['Correct', 'checkc'], partial: ['Partly correct', 'alert'], incorrect: ['Not quite yet', 'alert'], unclear: ['Answer unclear', 'help'] }

export default function Classroom() {
  const { lessonId = 'L1' } = useParams()
  const [sp] = useSearchParams()
  const nav = useNavigate(); const toast = useToast(); const qc = useQueryClient()
  const { me, setPrefs } = useAuth()
  const prefs = me?.prefs || {}
  const captions = prefs.captions ?? true, transcriptOn = prefs.transcript ?? false
  const [audio, setAudio] = useState(prefs.audio ?? true)
  const [rate, setRate] = useState<number>(prefs.rate ?? 1); const [volume, setVolume] = useState<number>(prefs.volume ?? 0.9)
  const lesson = useQuery({ queryKey: ['lesson', lessonId], queryFn: () => get<any>(`/api/vf/lessons/${lessonId}`) })
  const avatars = useQuery({ queryKey: ['avatars'], queryFn: () => get<AvatarInfo[] & any[]>('/api/vf/avatars') })
  const saved = useQuery({ queryKey: ['resumable', lessonId], queryFn: () => get<any>(`/api/vf/sessions/resumable?lesson_id=${lessonId}`) })
  const [avatarId, setAvatarId] = useState<string>(sp.get('avatar') || prefs.avatar || '')
  const [s, setS] = useState<Snap | null>(null)
  const [caption, setCaption] = useState(''); const [speaking, setSpeaking] = useState(false)
  const [transcript, setTranscript] = useState<Line[]>([])
  const [answer, setAnswer] = useState(''); const [emptyErr, setEmptyErr] = useState(false)
  const [assist, setAssist] = useState<Snap['assist'] | null>(null)
  const [side, setSide] = useState<{ q: string; a?: string; busy: boolean; citations?: any[]; engine?: string } | null>(null)
  const [ask, setAsk] = useState(''); const [busy, setBusy] = useState(false); const [prep, setPrep] = useState(false)
  const [blocked, setBlocked] = useState<string | null>(null); const [showA11y, setShowA11y] = useState(false)
  const [focus, setFocus] = useState(false); const [switching, setSwitching] = useState(false); const [presenter] = useState(sp.get('presenter') === '1')
  const [video, setVideo] = useState<string | null>(null)
  const [failNext, setFailNext] = useState(false)
  const stageRef = useRef<HTMLDivElement>(null); const rigRef = useRef<Rig | null>(null)
  const sRef = useRef<Snap | null>(null); sRef.current = s
  const playId = useRef(0); const teachPos = useRef(0); const queue = useRef<SayItem[]>([]); const qPos = useRef(0)
  const answerRef = useRef<HTMLTextAreaElement>(null)
  const avatar = useMemo(() => { const list = avatars.data || []; const want = s?.avatar_id || avatarId || lesson.data?.avatars?.[0]; return list.find((a: any) => a.id === want) || list[0] }, [avatars.data, s?.avatar_id, avatarId, lesson.data])

  // mount the avatar rig whenever the lecturer changes
  useEffect(() => {
    if (!avatar || !stageRef.current) return
    stageRef.current.innerHTML = ''
    rigRef.current = mountAvatar(stageRef.current, avatar, !!prefs.reducedMotion)
    setPrep(!Voice.ready(avatar.id)); Voice.load(avatar.id).then(() => setPrep(false))
    get(`/api/vf/media/${avatar.id}?lesson_id=${lessonId}`).then(m => Voice.setManifest(avatar.id, m)).catch(() => { })
    return () => { rigRef.current?.destroy(); rigRef.current = null }
  }, [avatar?.id, prefs.reducedMotion, !!lesson.data]) // eslint-disable-line
  useEffect(() => () => { playId.current++; Voice.cancel() }, [])
  // rig pose follows the engine state
  useEffect(() => {
    const r = rigRef.current; if (!r || !s) return
    r.setState(({ WAITING_FOR_ANSWER: 'listening', EVALUATING: 'thinking', QUESTION: 'asking' } as any)[s.state] || 'idle')
    if (s.state === 'COMPLETED' || s.last_result?.verdict === 'correct') r.setMood('happy')
  }, [s?.state, s?.last_result?.verdict, avatar?.id])

  const say = useCallback(async (items: SayItem[], onDone?: () => void, from = 0) => {
    const my = ++playId.current; queue.current = items; qPos.current = from
    for (let i = from; i < items.length; i++) {
      if (my !== playId.current) return false
      const it = items[i]; qPos.current = i
      setCaption(it.text); setSpeaking(true); setTranscript(t => [...t, { who: avatar?.short || 'Lecturer', text: it.text }])
      const ok = await Voice.say(it.text, it.id, { avatarId: avatar!.id, rig: rigRef.current, muted: !audio, rate, volume, voiceHint: avatar?.calib?.voiceHint, pitch: avatar?.calib?.pitch, onVideo: setVideo })
      if (my !== playId.current || !ok) return false
      if (it.kind === 'teach' && it.idx != null) {
        teachPos.current = it.idx + 1
        const cur = sRef.current
        if (cur) post(`/api/vf/sessions/${cur.id}/actions`, { action: 'line_done', payload: { sent: it.idx + 1 } }).catch(() => { })
      }
    }
    setSpeaking(false)
    if (my === playId.current) onDone?.()
    return true
  }, [avatar, audio, rate, volume])

  const apply = useCallback((snap: Snap, opts: { play?: boolean } = {}) => {
    setS(snap); setBlocked(snap.blocked || null)
    if (snap.assist) setAssist(snap.assist)
    if (snap.error?.field === 'answer') setEmptyErr(true)
    if (opts.play === false || !snap.say?.length) {
      // no speech: auto-advance states that need it (e.g. resumed into FEEDBACK)
      return
    }
    say(snap.say, () => { const nxt = AUTO[snap.state]; if (nxt) act(nxt) })
  }, [say]) // eslint-disable-line

  const act = useCallback(async (action: string, payload: any = {}) => {
    const cur = sRef.current; if (!cur) return
    if (['answer', 'retry_eval'].includes(action)) setBusy(true)
    try {
      const snap = await post<Snap>(`/api/vf/sessions/${cur.id}/actions`, { action, version: cur.version, payload: { ...payload, hour: new Date().getHours() } })
      if (!['hint', 'reteach', 'simpler'].includes(action) || snap.state !== 'WAITING_FOR_ANSWER') { if (!['line_done'].includes(action)) setAssist(snap.assist || null) }
      if (action === 'answer' && snap.state !== 'WAITING_FOR_ANSWER') setTranscript(t => [...t])
      apply(snap)
      if (['continue', 'assisted', 'skip', 'save_exit'].includes(action) || snap.state === 'COMPLETED') qc.invalidateQueries({ queryKey: ['resumable', lessonId] })
    } catch (e: any) {
      if (e instanceof ApiError && e.body?.session) { setS(e.body.session); setBlocked(e.body.session.blocked || e.message); if (e.status === 409) toast(e.message) }
      else toast(e.message || 'Something went wrong', true)
    } finally { setBusy(false) }
  }, [apply, toast, qc, lessonId])

  const start = async (resume: boolean) => {
    Voice.unlock()
    if (!Voice.ready(avatar!.id)) { setPrep(true); await Voice.load(avatar!.id); setPrep(false) }
    try {
      const snap = await post<Snap>('/api/vf/sessions', { lesson_id: lessonId, avatar_id: avatar!.id, resume })
      setTranscript([]); setAssist(null); setSide(null); sRef.current = snap; setS(snap)
      const started = await post<Snap>(`/api/vf/sessions/${snap.id}/actions`, { action: 'start', version: snap.version, payload: { resume, hour: new Date().getHours() } })
      apply(started)
    } catch (e: any) { toast(e.message, true) }
  }

  const submit = async (opts: any = {}) => {
    const text = answer.trim()
    if (!text) { setEmptyErr(true); answerRef.current?.focus(); return }
    setEmptyErr(false); playId.current++; Voice.cancel(); setSpeaking(false)
    setTranscript(t => [...t, { who: me?.first || 'You', text, k: 'u' }])
    const key = crypto.randomUUID?.() || String(Date.now())
    await act('answer', { text, idempotency_key: key, simulate_failure: failNext, ...opts })
    setFailNext(false)
  }
  useEffect(() => { if (s?.state === 'WAITING_FOR_ANSWER') setTimeout(() => answerRef.current?.focus(), 60) }, [s?.state])
  useEffect(() => { if (s?.state === 'RETRY_OR_CONTINUE' && s.last_result?.verdict === 'correct') setAnswer('') }, [s?.state, s?.last_result?.verdict])

  const pause = () => { playId.current++; Voice.cancel(); setSpeaking(false); act('pause', { sent: teachPos.current }) }
  const resume = () => { Voice.unlock(); act('resume') }
  const askSide = async (raw: string) => {
    const q = raw.trim(); if (!q || !s) return
    const low = q.toLowerCase(); setAsk('')
    if (/^(repeat|say (that|it) again)/.test(low)) return act('repeat', { sent: teachPos.current })
    if (/simpl|easier|don.?t understand/.test(low) && s.state === 'TEACHING') return act('simpler')
    if (/^(pause|stop)/.test(low)) return pause()
    if (/hint/.test(low) && ['WAITING_FOR_ANSWER', 'RETRY_OR_CONTINUE'].includes(s.state)) return act('hint')
    const resumeFrom = qPos.current; const wasQueue = queue.current; const wasTeaching = s.state === 'TEACHING'
    playId.current++; Voice.cancel(); setTranscript(t => [...t, { who: me?.first || 'You', text: q, k: 'u' }])
    setSide({ q, busy: true }); rigRef.current?.setState('thinking')
    try {
      const r = await post<any>(`/api/vf/sessions/${s.id}/ask`, { q })
      setSide({ q, a: r.answer, busy: false, citations: r.citations, engine: r.engine }); rigRef.current?.setState('idle')
      await say(r.say)
      if (wasTeaching && sRef.current?.state === 'TEACHING') {
        await say([{ id: 'continue', text: 'Now, let me continue.', kind: 'speech' }])
        say(wasQueue, () => act('taught'), resumeFrom)
      }
    } catch (e: any) { setSide(null); toast(e.message, true) }
  }

  // keyboard shortcuts
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement; const typing = /INPUT|TEXTAREA|SELECT/.test(t.tagName)
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && t.id === 'vc-answer') { e.preventDefault(); submit(); return }
      if (typing || !s) return
      const key = e.key.toLowerCase()
      if (key === ' ') { e.preventDefault(); s.state === 'PAUSED' ? resume() : pause() }
      else if (key === 'r') act('repeat', { sent: teachPos.current })
      else if (key === 's') act('simpler')
      else if (key === 'h') act('hint')
      else if (key === 'c') setPrefs({ captions: !captions })
      else if (key === 't') setPrefs({ transcript: !transcriptOn })
    }
    document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k)
  })

  if (lesson.isLoading || avatars.isLoading) return <Loading label="Preparing your classroom…" />
  if (lesson.error) return <ErrorBox error={lesson.error} retry={() => lesson.refetch()} />
  const L = lesson.data; const segs = L.segments as any[]
  const st = s?.state || 'IDLE'
  const cpFull = s ? segs[s.seg]?.checkpoint : null
  const a = avatar!
  const can = {
    pause: !['IDLE', 'COMPLETED', 'EVALUATING', 'PAUSED'].includes(st), repeat: !['IDLE', 'EVALUATING', 'PAUSED', 'ERROR_RECOVERY'].includes(st),
    simpler: ['TEACHING', 'WAITING_FOR_ANSWER', 'RETRY_OR_CONTINUE'].includes(st) && L.policy.simpler,
    hint: !!cpFull && ['WAITING_FOR_ANSWER', 'RETRY_OR_CONTINUE'].includes(st) && L.policy.hints,
  }
  const outcomes = s?.outcome || {}
  const doneCount = st === 'COMPLETED' ? segs.length : Object.keys(outcomes).length

  const head = <div className="vc-head">
    <Avatar name={a.name} kind="t" size={36} />
    <div className="ttl"><b>{L.title}</b><span>{L.course_code} · {L.module} · Digital lecturer: {a.name}</span></div>
    <span className={`state-pill ${st}`} title="Teaching engine state"><i />{st}</span>
    <div style={{ minWidth: 160, flex: '0 1 220px' }}><div className="xs muted" style={{ marginBottom: 3 }}>Lesson progress · {doneCount} of {segs.length} checkpoints</div>
      <div className="segbar">{segs.map((sg, i) => <i key={sg.id} className={outcomes[sg.checkpoint.id] || (s && i < s.seg) || st === 'COMPLETED' ? 'd' : s && i === s.seg && st !== 'IDLE' ? 'c' : ''} />)}</div></div>
    <button className="btn sm" onClick={() => setSwitching(true)}><Icon n="swap" />Switch lecturer</button>
    <button className="btn sm" onClick={() => setFocus(!focus)} aria-pressed={focus}><Icon n="full" /><span>{focus ? 'Exit focus' : 'Focus mode'}</span></button>
    <button className="btn sm" onClick={() => { if (s) { playId.current++; Voice.cancel(); act('save_exit').then(() => { toast('Progress saved. You can resume from your last completed checkpoint.'); nav('/s-course') }) } else nav('/s-course') }}><Icon n="save" />Save & exit</button>
  </div>

  const engineLbl = (e?: string) => e === 'claude' ? <AiTag label="Claude · live" /> : <span className="b out">Rubric matcher · offline</span>
  let ia: React.ReactNode
  if (st === 'IDLE') {
    const sv = saved.data
    ia = <><div className="iah"><h3>Ready when you are</h3></div><div className="iab">
      <p>{a.name} will teach this lesson, ask you questions and wait for your typed answers before moving on.</p>
      <dl className="kv"><dt>Learner</dt><dd>{me?.name}</dd><dt>Checkpoints</dt><dd>{segs.filter(x => x.checkpoint.mandatory).length} mandatory · {segs.filter(x => !x.checkpoint.mandatory).length} optional</dd>
        <dt>Answer checking</dt><dd>Against lecturer-defined concepts</dd><dt>Voice</dt><dd>{prep ? 'Preparing voice…' : Voice.ready(a.id) ? 'Natural neural voice with lip-sync' : 'Browser voice'}</dd></dl>
      {sv ? <><div className="note teal"><Icon n="save" /><div>Saved session found: <b>{sv.title}</b>.</div></div>
        <div className="row"><button className="btn teal" onClick={() => start(true)} disabled={prep}><Icon n="playc" />Resume from last checkpoint</button><button className="btn" onClick={() => start(false)} disabled={prep}>Start over</button></div></>
        : <button className="btn teal lg" onClick={() => start(false)} disabled={prep || !a}>{prep ? <><span className="typing"><i /><i /><i /></span> Preparing voice…</> : <><Icon n="playc" />Start session</>}</button>}
      <p className="xs muted">Sound starts when you press Start. Your official grades are never set by the virtual lecturer.</p></div></>
  } else if ((st === 'WAITING_FOR_ANSWER' || st === 'QUESTION') && s?.checkpoint) {
    const cp = s.checkpoint; const at = cp.attempts
    ia = <><div className="iah"><h3>{cp.mandatory ? 'Checkpoint question' : 'Optional knowledge check'}</h3><span className={`b ${cp.mandatory ? 'warn' : 'info'}`}>{cp.mandatory ? 'Mandatory' : 'Optional'}</span></div><div className="iab">
      <div className="qcard"><div className="eyebrow" style={{ color: 'var(--teal)' }}>{a.short} asks</div><div className="q">{cp.question}</div></div>
      {assist && <div className={`note ${assist.kind === 'hint' ? 'gold' : 'teal'}`}><Icon n={assist.kind === 'hint' ? 'bulb' : 'simple'} /><div><b>{assist.kind === 'hint' ? `Hint ${assist.level} of ${assist.of}` : assist.kind === 'reteach' ? `${a.short} explains it differently` : 'Simpler explanation'}</b><br />{assist.text}</div></div>}
      <div className="field"><label htmlFor="vc-answer">Your answer</label>
        <textarea ref={answerRef} className={`inp ${emptyErr ? 'bad' : ''}`} id="vc-answer" rows={4} placeholder="Type your answer in your own words…" value={answer} maxLength={1200}
          onChange={e => { setAnswer(e.target.value); if (emptyErr) setEmptyErr(false) }} />
        {emptyErr ? <span className="err" role="alert"><Icon n="alert" />Type an answer before submitting — the lesson continues once your answer has been checked.</span>
          : <span className="hint">Attempt {at + 1} of {cp.max_attempts}{at ? ` · ${cp.max_attempts - at} remaining` : ''} · Ctrl+Enter to submit</span>}</div>
      <div className="row"><button className="btn teal" onClick={() => submit()} disabled={busy}><Icon n="send" />Submit answer</button>
        {L.policy.hints && <button className="btn" onClick={() => act('hint')}><Icon n="bulb" />Hint</button>}
        <button className="btn ghost" onClick={() => act('repeat')}><Icon n="repeat" />Repeat question</button>
        {!cp.mandatory && <button className="btn ghost" onClick={() => act('skip')}>Skip (optional)</button>}</div>
      <div className="row" style={{ gap: 8 }}><span className="b warn"><span className="d" />Waiting for your response</span>{cp.mandatory && <span className="lockline" style={{ flex: 1 }}><Icon n="lock" />Next segment unlocks after this checkpoint is satisfied</span>}</div>
      {blocked && <div className="note bad"><Icon n="lock" /><div>{blocked}</div></div>}
      <div className="row xs muted">Stuck? <button className="btn sm ghost" onClick={() => act('reteach')}>Explain it differently</button>
        <button className="btn sm ghost" onClick={() => setAssist({ kind: 'review', text: segs[s.seg].speech.join(' ') })}>Review this segment</button>
        <button className="btn sm ghost" onClick={() => nav(`/s-support?topic=${encodeURIComponent(L.course_code + ' ' + cp.id)}`)}>Ask my lecturer</button></div></div></>
  } else if (st === 'EVALUATING') {
    ia = <><div className="iah"><h3>Checking your answer</h3></div><div className="iab"><div className="card flat"><div className="eyebrow">You wrote</div><p style={{ marginTop: 4 }}>{answer}</p></div>
      <div className="row"><span className="typing"><i /><i /><i /></span><span>Comparing your answer with {cpFull?.concepts.length} lecturer-defined concepts…</span></div>
      <p className="xs muted">The AI identifies concepts; whether you can move on is decided by the lecturer’s configured rule.</p></div></>
  } else if ((st === 'FEEDBACK' || st === 'RETRY_OR_CONTINUE') && s?.last_result && cpFull) {
    const r = s.last_result; const [vl, vi] = VERDICT[r.verdict] || ['', 'dot']; const passed = r.verdict === 'correct'
    let actions: React.ReactNode
    if (passed) actions = <><button className="btn teal" onClick={() => act('continue')} disabled={st !== 'RETRY_OR_CONTINUE'}><Icon n="arrow" />Continue lesson</button><span className="b good"><Icon n="unlock" />Next segment unlocked</span></>
    else if (s.can_assist) actions = <><div className="note teal"><Icon n="hand" /><div><b>Assisted learning path</b> (configured by your lecturer): read the model answer, then continue. This checkpoint will be flagged so your lecturer can follow up.</div></div>
      {s.model_answer && <div className="card flat small"><b>Model answer</b><p>{s.model_answer}</p></div>}
      <div className="row"><button className="btn teal" onClick={() => act('assisted')}><Icon n="check" />I’ve read it — continue</button><button className="btn" onClick={() => nav('/s-support')}><Icon n="msg" />Message my lecturer</button></div></>
    else actions = <><button className="btn teal" onClick={() => act('retry')} disabled={st !== 'RETRY_OR_CONTINUE'}><Icon n="edit" />Try again</button>
      {L.policy.hints && <button className="btn" onClick={() => act('hint')}><Icon n="bulb" />Get a hint</button>}
      <button className="btn" onClick={() => act('reteach')}><Icon n="simple" />Explain differently</button>
      {cpFull.mandatory ? <button className="btn ghost dis" aria-disabled="true" title="Locked until the checkpoint is satisfied" onClick={() => act('continue')}><Icon n="lock" />Continue</button> : <button className="btn ghost" onClick={() => act('skip')}>Skip (optional)</button>}</>
    ia = <><div className="iah"><h3>Feedback on your answer</h3>{engineLbl(r.engine)}</div><div className="iab">
      <div className={`verdict ${r.verdict}`}><Icon n={vi} size={20} /><span>{vl}</span><span className="sp" /><span className="xs" style={{ fontWeight: 500 }}>Attempt {r.n} of {cpFull.maxAttempts}</span></div>
      <div className="card flat" style={{ padding: '10px 12px' }}><div className="eyebrow">Your answer</div><p className="small" style={{ marginTop: 3 }}>{r.answer}</p></div>
      <div><div className="eyebrow" style={{ marginBottom: 4 }}>Concepts</div>
        {cpFull.concepts.map((c: any) => { const ok = r.found.includes(c.id); return <div key={c.id} className={`concept ${ok ? 'ok' : 'miss'}`}><Icon n={ok ? 'checkc' : 'dot'} /><span>{c.label}{!c.required && <span className="xs muted"> (supporting)</span>}</span></div> })}
        {r.mis.map(id => <div key={id} className="concept bad"><Icon n="x" /><span>{cpFull.misconceptions.find((m: any) => m.id === id)?.label || id}</span></div>)}</div>
      {r.ai_feedback && <div className="msg ai" style={{ maxWidth: '100%' }}><div className="bub"><AiTag label="AI-generated feedback" /><p style={{ marginTop: 6 }}>{r.ai_feedback}</p></div></div>}
      {r.confidence === 'low' && <p className="xs muted">This check ran with reduced confidence and has been sent to your lecturer for review.</p>}
      <div className="row">{actions}</div>
      {blocked && <div className="note bad"><Icon n="lock" /><div>{blocked}</div></div>}</div></>
  } else if (st === 'ERROR_RECOVERY') {
    ia = <><div className="iah"><h3>We couldn’t check your answer</h3><span className="b bad"><span className="d" />Service unavailable</span></div><div className="iab">
      <div className="note bad"><Icon n="wifioff" /><div><b>The AI evaluation service didn’t respond.</b> Your answer is saved and nothing has been marked. The lesson is paused at this checkpoint — it has not been skipped or marked correct.</div></div>
      <div className="card flat" style={{ padding: '10px 12px' }}><div className="eyebrow">Saved answer</div><p className="small" style={{ marginTop: 3 }}>{s?.pending_answer || answer}</p></div>
      <div className="row"><button className="btn teal" onClick={() => act('retry_eval')} disabled={busy}><Icon n="refresh" />Retry evaluation</button>
        <button className="btn" onClick={() => act('retry_eval', { engine: 'rubric' })} disabled={busy}><Icon n="list" />Use offline rubric checker</button>
        <button className="btn" onClick={() => act('back_to_answer')}><Icon n="edit" />Edit my answer</button></div>
      <p className="xs muted">Error code: <span className="mono">{s?.error?.code || 'upstream_error'}</span> · logged for the platform team · counted as a technical failure, not a wrong answer.</p></div></>
  } else if (st === 'COMPLETED') {
    ia = <Recap s={s!} segs={segs} name={me?.first || ''} onProgress={() => nav('/s-progress')} onCourse={() => nav('/s-course')} />
  } else if (st === 'PAUSED') {
    ia = <><div className="iah"><h3>Paused</h3></div><div className="iab"><p>Your place is saved at <b>{segs[s!.seg]?.title}</b>. Nothing advances while paused.</p>
      <div className="row"><button className="btn teal" onClick={resume}><Icon n="playc" />Resume</button><button className="btn ghost" onClick={() => setShowA11y(true)}><Icon n="cog" />Accessibility</button></div></div></>
  } else {
    ia = <><div className="iah"><h3>{st === 'WELCOME' ? 'Welcome' : 'Now teaching'}</h3><span className="b teal"><span className="d" />{s?.state_label}</span></div><div className="iab">
      <div className="card flat" style={{ padding: '10px 12px' }}><div className="eyebrow">{a.short} is saying</div><p style={{ marginTop: 4 }}>{caption || '…'}</p></div>
      {side && <div className="msg ai" style={{ maxWidth: '100%' }}><div className="bub"><div className="xs muted">You asked: {side.q}</div>
        {side.busy ? <span className="typing"><i /><i /><i /></span> : <><p style={{ marginTop: 4 }}>{side.a}</p>
          {!!side.citations?.length && <div className="src">{side.citations.map((c: any) => <span key={c.id}>{c.source}{c.page ? ` · §${c.page}` : ''}</span>)}</div>}
          <span className="ai-tag" style={{ marginTop: 6 }}><Icon n="ai" />{side.engine === 'claude' ? 'AI-generated · grounded in lesson material' : 'Prepared answer from lesson material'}</span></>}</div></div>}
      <form className="field" onSubmit={e => { e.preventDefault(); askSide(ask) }}><label htmlFor="vc-ask">Ask {a.short} or give a command</label>
        <div className="row" style={{ flexWrap: 'nowrap' }}><input className="inp" id="vc-ask" value={ask} onChange={e => setAsk(e.target.value)} placeholder="e.g. “What is deep learning?” or “repeat”" maxLength={500} />
          <button className="btn" type="submit"><Icon n="send" /><span className="sr">Ask</span></button></div>
        <span className="hint">Commands: repeat · simpler · pause. Questions are answered from approved lesson material only.</span></form>
      <div className="lockline"><Icon n="lock" />{segs[s?.seg || 0]?.checkpoint.mandatory ? 'A mandatory checkpoint follows this explanation.' : 'An optional check follows this explanation.'}</div></div></>
  }

  const topics = [{ key: 'w', title: 'Welcome & objectives', cp: null as any }, ...segs.map((x, i) => ({ key: String(i), title: x.title, cp: x.checkpoint, i })), { key: 'r', title: 'Recap & next steps', cp: null }]
  const tStatus = (it: any) => {
    if (it.key === 'w') return ['IDLE', 'WELCOME'].includes(st) ? 'cur' : 'done'
    if (it.key === 'r') return st === 'COMPLETED' ? 'done' : 'lock'
    if (st === 'COMPLETED' || outcomes[it.cp.id]) return 'done'
    if (s && it.i === s.seg && !['IDLE', 'WELCOME'].includes(st)) return 'cur'
    return s && it.i < s.seg ? 'done' : 'lock'
  }

  const body = <>
    {head}
    <div className="vc" style={{ marginTop: 12 }}>
      <div className="stack" style={{ gap: 10 }}>
        <div className="stage">
          <div className="bgx" /><div className="shelf" /><div className="win" />
          <div ref={stageRef} style={{ position: 'absolute', inset: 0 }} />
          {video && <video key={video} className="media" src={video} autoPlay muted playsInline style={{ objectPosition: avatar?.calib?.pos }} />}
          <div className="ov-top"><span className={`live ${LIVE[st] || ''}`}><i /><span>{s?.state_label || 'Ready'}</span></span>
            {!video && <span className="sim">Animated portrait with lip-sync driven by the lecturer’s neural voice. Full-body video plays where rendered.</span>}</div>
          <div className="namecard"><b>{a.name}</b><span>{a.subject} · AI digital faculty</span></div>
          {captions && speaking && caption && <div className="caps">{caption}</div>}
          {st === 'PAUSED' && <div className="pausedov"><div className="box"><Icon n="pause" /><b>Lesson paused</b><span className="small" style={{ color: '#B9C7D8' }}>Your place is kept. Resume when you’re ready.</span><button className="btn teal" onClick={resume}><Icon n="playc" />Resume</button></div></div>}
        </div>
        <div className="ctlbar" role="toolbar" aria-label="Lesson controls">
          {st === 'PAUSED' ? <button className="btn teal" onClick={resume}><Icon n="playc" />Resume</button>
            : st === 'IDLE' ? <button className="btn teal" onClick={() => start(!!saved.data)} disabled={prep}><Icon n="playc" />Start session</button>
              : <button className="btn" onClick={pause} disabled={!can.pause} title="Pause (Space)"><Icon n="pause" />Pause</button>}
          <button className="btn" onClick={() => act('repeat', { sent: teachPos.current })} disabled={!can.repeat} title="Repeat (R)"><Icon n="repeat" />Repeat</button>
          <button className="btn" onClick={() => act('simpler')} disabled={!can.simpler} title="Explain more simply (S)"><Icon n="simple" />Explain simply</button>
          <button className="btn" onClick={() => act('hint')} disabled={!can.hint} title="Hint (H)"><Icon n="bulb" />Hint</button>
          <span className="sep" />
          <button className={`btn ${captions ? 'teal' : ''}`} onClick={() => setPrefs({ captions: !captions })} aria-pressed={captions} title="Captions (C)"><Icon n="cc" /><span className="sr">Captions</span></button>
          <button className={`btn ${transcriptOn ? 'teal' : ''}`} onClick={() => setPrefs({ transcript: !transcriptOn })} aria-pressed={transcriptOn} title="Transcript (T)"><Icon n="list" /><span className="sr">Transcript</span></button>
          <button className="btn" onClick={() => { setAudio(!audio); setPrefs({ audio: !audio }) }} aria-pressed={audio} title="Voice on/off"><Icon n={audio ? 'vol' : 'mute'} /><span className="sr">Voice</span></button>
          <span className="rng"><label htmlFor="vc-rate">Speed</label><input type="range" id="vc-rate" min={0.7} max={1.4} step={0.05} value={rate} onChange={e => setRate(+e.target.value)} onMouseUp={() => setPrefs({ rate })} /><span className="num">{rate.toFixed(2)}×</span></span>
          <span className="rng"><label htmlFor="vc-vol">Vol</label><input type="range" id="vc-vol" min={0} max={1} step={0.05} value={volume} onChange={e => setVolume(+e.target.value)} onMouseUp={() => setPrefs({ volume })} /></span>
          <span className="sp" /><button className="btn ghost" onClick={() => setShowA11y(!showA11y)} aria-expanded={showA11y}><Icon n="cog" />Accessibility</button>
        </div>
        {showA11y && <div className="card"><div className="hd"><h3>Accessibility & session recovery</h3><button className="btn sm ghost" onClick={() => setShowA11y(false)}><Icon n="x" />Close</button></div>
          <div className="g g2"><div className="col">
            <Switch id="a-cc" checked={captions} onChange={v => setPrefs({ captions: v })} label="Captions on screen" />
            <Switch id="a-tr" checked={transcriptOn} onChange={v => setPrefs({ transcript: v })} label="Show live transcript" />
            <Switch id="a-rm" checked={!!prefs.reducedMotion} onChange={v => setPrefs({ reducedMotion: v })} label="Reduce avatar motion" />
            <Switch id="a-au" checked={audio} onChange={v => { setAudio(v); setPrefs({ audio: v }) }} label="Lecturer voice (off = read captions only)" /></div>
            <div className="col small"><b>Keyboard shortcuts</b><dl className="kv"><dt>Space</dt><dd>Pause / resume</dd><dt>R</dt><dd>Repeat</dd><dt>S</dt><dd>Explain more simply</dd><dt>H</dt><dd>Hint</dd><dt>C / T</dt><dd>Captions / transcript</dd><dt>Ctrl+Enter</dt><dd>Submit answer</dd></dl>
              <div className="note"><Icon n="save" /><div>Progress is saved on the server at every step. You can resume from your last completed checkpoint on any device.</div></div></div></div></div>}
        {(presenter || me?.role !== 'student') && s && <div className="card flat"><div className="hd"><h3>Presenter controls</h3><span className="xs muted">Engine trace · visible to staff and in presenter mode</span></div>
          <div className="trace">{s.trace.map((t, i) => <span key={i} className={i === s.trace.length - 1 ? 'cur' : ''}>{t}</span>)}</div>
          <div className="row" style={{ marginTop: 8 }}><label className="chk"><input type="checkbox" checked={failNext} onChange={e => setFailNext(e.target.checked)} />Simulate an evaluation outage on the next answer</label></div></div>}
      </div>
      <div className="vc-side">
        <div style={{ order: ['TEACHING', 'WELCOME', 'IDLE'].includes(st) ? 0 : 1 }}><Slide state={st} seg={segs[s?.seg ?? 0]} segIndex={s?.seg ?? 0} segCount={segs.length} lesson={L} /></div>
        <div className="ia" aria-live="polite">{ia}</div>
        <div className="card" style={{ order: 2 }}><div className="hd" style={{ marginBottom: 8 }}><h3>Topics</h3><span className="xs muted">{L.dur} min</span></div>
          <div className="topics">{topics.map((it, k) => { const t = tStatus(it); const o = it.cp && outcomes[it.cp.id]
            return <div key={it.key} className={`topic ${t}`}><span className="st">{t === 'done' ? <Icon n="check" /> : t === 'lock' ? <Icon n="lock" /> : k}</span>
              <span style={{ flex: 1, minWidth: 0 }}>{it.title}{it.cp && <span className="xs muted" style={{ display: 'block' }}>{it.cp.mandatory ? 'Mandatory checkpoint' : 'Optional check'}{o ? ' · ' + ({ passed: 'passed', assisted: 'assisted — flagged for lecturer', skipped: 'skipped' } as any)[o] : ''}</span>}</span></div> })}</div></div>
        {transcriptOn && <div className="card" style={{ order: 3 }}><div className="hd" style={{ marginBottom: 8 }}><h3>Transcript</h3><span className="xs muted">{transcript.length} lines</span></div>
          <TranscriptList lines={transcript} /></div>}
      </div>
    </div>
    {switching && <Modal title="Switch lecturer" onClose={() => setSwitching(false)} wide>
      <p className="small muted">Your place in the lesson is kept. The new lecturer continues exactly where you left off.</p>
      <div className="faculty">{(avatars.data || []).filter((x: any) => (L.avatars || []).includes(x.id)).map((x: any) => <button key={x.id} className={`fcard ${x.id === a.id ? 'sel' : ''}`} style={{ textAlign: 'left', cursor: 'pointer', padding: 0 }}
        onClick={async () => { setSwitching(false); if (x.id === a.id) return; setAvatarId(x.id); setPrefs({ avatar: x.id }); if (s && st !== 'IDLE') { playId.current++; Voice.cancel(); await Voice.load(x.id); act('switch_avatar', { avatar_id: x.id }) } }}>
        <div className="por"><img src={x.portrait} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: x.calib?.pos }} /></div>
        <div className="bd"><b>{x.name}</b><span className="small muted">{x.subject}</span><span className="xs muted">{x.voice}</span></div></button>)}</div>
    </Modal>}
  </>
  return focus ? <div className="vc-fullwrap">{body}</div> : body
}

function TranscriptList({ lines }: { lines: Line[] }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight }, [lines.length])
  return <div className="transcript" ref={ref}>{lines.length ? lines.map((l, i) => <div key={i} className={`ln ${l.k || ''}`}><b>{l.who}</b><span>{l.text}</span></div>)
    : <span className="muted small">The transcript appears here as the lecturer speaks.</span>}</div>
}

function Recap({ s, segs, name, onProgress, onCourse }: { s: Snap; segs: any[]; name: string; onProgress: () => void; onCourse: () => void }) {
  const q = useQuery({ queryKey: ['vf-summary', s.id], queryFn: () => get<any>(`/api/vf/sessions/${s.id}/summary`) })
  const rows = q.data?.checkpoints || []
  const mastered = rows.filter((r: any) => r.outcome === 'passed' && r.first === 'correct')
  const revisit = rows.filter((r: any) => r.outcome === 'assisted' || (r.outcome === 'passed' && r.first !== 'correct'))
  return <><div className="iah"><h3>Lesson complete</h3><Badge kind="good"><Icon n="award" />Completed</Badge></div><div className="iab">
    <p>Well done, {name}. Here is your session summary.</p>
    {q.isLoading ? <Loading /> : <>
      <div className="g g3" style={{ gap: 8 }}>
        <div className="kpi"><div className="l">Checkpoints</div><div className="v">{rows.filter((r: any) => r.outcome !== 'skipped' && r.outcome !== 'open').length}/{segs.length}</div></div>
        <div className="kpi"><div className="l">First-try correct</div><div className="v">{rows.filter((r: any) => r.first === 'correct').length}</div></div>
        <div className="kpi"><div className="l">Hints used</div><div className="v">{rows.reduce((x: number, r: any) => x + r.hints, 0)}</div></div></div>
      <div><div className="eyebrow">Concepts mastered</div>{mastered.length ? mastered.map((r: any) => <div key={r.id} className="concept ok"><Icon n="checkc" /><span>{r.concepts}</span></div>) : <p className="small muted">Concepts reached with support are listed below.</p>}</div>
      <div><div className="eyebrow">Worth revisiting</div>{revisit.length ? revisit.map((r: any) => <div key={r.id} className="concept miss"><Icon n="dot" /><span>{r.question} <span className="xs muted">({r.attempts} attempt{r.attempts === 1 ? '' : 's'}{r.outcome === 'assisted' ? ', assisted' : ''})</span></span></div>) : <p className="small muted">Nothing flagged — great work.</p>}</div>
      {q.data?.next?.length > 0 && <div className="card flat"><div className="eyebrow">Recommended next</div>{q.data.next.map((n: any) => <div key={n.title} className="row" style={{ marginTop: 6 }}><Icon n={n.type === 'reading' ? 'book' : 'play'} /><div style={{ flex: 1 }}><b>{n.title}</b><div className="xs muted">{n.module} · {n.dur} min</div></div></div>)}</div>}
    </>}
    <div className="row"><button className="btn teal" onClick={onProgress}><Icon n="line" />View my progress</button><button className="btn" onClick={onCourse}>Back to course</button></div></div></>
}
