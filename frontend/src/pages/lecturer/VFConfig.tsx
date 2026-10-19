import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { mountAvatar, Rig } from '../../classroom/avatar'
import { Voice } from '../../classroom/voice'
import { Icon } from '../../components/Icon'
import { Badge, Card, Empty, ErrorBox, Field, Loading, Note, PageHead, Switch, useToast } from '../../components/ui'
import { get, post, put } from '../../lib/api'
import { fmtDate } from '../../lib/format'
import { Sel } from './shared'

const previewLines = (a: any) => [`Hello, I'm ${a.name}.`, `I teach ${a.teach}.`, "Let's begin today's lesson."]
async function lineHash(avatarId: string, text: string) {
  const norm = text.split(/\s+/).filter(Boolean).join(' ')
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${avatarId}|kokoro-1|${norm}`))
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 40)
  } catch { return '' }
}
const MEDIA_BADGE: Record<string, string> = { ready: 'good', audio: 'teal', rendering: 'gold', pending: 'warn', missing: 'out', failed: 'bad', review: 'warn' }

export default function VFConfig() {
  const [sp, setSp] = useSearchParams()
  const lessons = useQuery({ queryKey: ['vf-lect-lessons'], queryFn: () => get<any[]>('/api/lecturer/vf/lessons') })
  if (lessons.isLoading) return <Loading />
  if (lessons.error) return <ErrorBox error={lessons.error} retry={() => lessons.refetch()} />
  const ls = lessons.data || []
  if (!ls.length) return <><PageHead no={36} title="Configure digital lecturer" /><Empty icon="cap" title="No virtual faculty lessons">Create a lesson in the Lesson editor first.</Empty></>
  const lid = sp.get('lesson') && ls.some(l => l.id === sp.get('lesson')) ? sp.get('lesson')! : ls[0].id
  return <Config key={lid} lid={lid} lessons={ls} onPick={id => setSp({ lesson: id })} />
}

function Config({ lid, lessons, onPick }: { lid: string; lessons: any[]; onPick: (id: string) => void }) {
  const qc = useQueryClient(); const toast = useToast()
  const cfg = useQuery({ queryKey: ['vf-config', lid], queryFn: () => get<any>(`/api/lecturer/vf/lessons/${lid}/config`) })
  const avatars = useQuery({ queryKey: ['avatars'], queryFn: () => get<any[]>('/api/vf/avatars') })
  const [sel, setSel] = useState<string[]>([]); const [pol, setPol] = useState<any>(null); const [focus, setFocus] = useState('')
  const [glob, setGlob] = useState<any>(null); const [rate, setRate] = useState(1); const [dirty, setDirty] = useState(false)
  useEffect(() => { if (cfg.data) { setSel(cfg.data.avatars); setPol(cfg.data.policy); setGlob(cfg.data.global); setFocus(f => f || cfg.data.avatars[0] || ''); setDirty(false) } }, [cfg.data])
  const invalidate = () => { qc.invalidateQueries({ queryKey: ['vf-config', lid] }); qc.invalidateQueries({ queryKey: ['vf-lect-lessons'] }) }
  const save = useMutation({ mutationFn: () => put<any>(`/api/lecturer/vf/lessons/${lid}/config`, { avatars: sel, policy: { threshold: pol.threshold, hints: pol.hints, assisted: pol.assisted, simpler: pol.simpler, maxAttempts: pol.maxAttempts || null } }),
    onSuccess: r => { toast(r.changes.length ? 'Settings saved and recorded in the audit log' : 'No changes to save'); setDirty(false); invalidate() }, onError: (e: any) => toast(e.message, true) })
  const pub = useMutation({ mutationFn: (on: boolean) => post<any>(`/api/lecturer/lessons/${lid}/${on ? 'publish' : 'unpublish'}`),
    onSuccess: (_, on) => { toast(on ? `Published to ${cfg.data.course.code} students` : 'Unpublished — students can no longer start this lesson'); invalidate() }, onError: (e: any) => toast(e.message, true) })
  const saveGlob = useMutation({ mutationFn: () => put('/api/lecturer/vf/settings', glob), onSuccess: () => { toast('Global virtual faculty defaults saved'); invalidate() }, onError: (e: any) => toast(e.message, true) })
  if (cfg.isLoading || avatars.isLoading || !pol) return <Loading />
  if (cfg.error || avatars.error) return <ErrorBox error={cfg.error || avatars.error} retry={() => { cfg.refetch(); avatars.refetch() }} />
  const c = cfg.data; const all = avatars.data || []
  const fa = all.find(a => a.id === focus) || all[0]
  const setP = (k: string, v: any) => { setPol((p: any) => ({ ...p, [k]: v })); setDirty(true) }
  const toggle = (id: string) => { setSel(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]); setDirty(true) }
  const published = c.status === 'published'
  return <>
    <PageHead no={36} title="Configure digital lecturer" sub="Set who teaches, how they sound, which approved material they use, and the rules at each checkpoint. Only authorised staff can publish."
      actions={<><Link className="btn" to={`/s-classroom/${lid}?avatar=${fa?.id || sel[0] || ''}`} title="Opens the lesson with the lecturer selected below"><Icon n="eye" />Preview with {fa?.short || 'lecturer'}</Link>
        <button className="btn pri" disabled={!dirty || !sel.length || save.isPending} onClick={() => save.mutate()}><Icon n="save" />{save.isPending ? 'Saving…' : 'Save settings'}</button>
        <button className={`btn ${published ? 'danger' : 'teal'}`} disabled={pub.isPending || dirty} title={dirty ? 'Save your settings first' : ''} onClick={() => (!published || confirm('Unpublish? Students will no longer be able to start this lesson.')) && pub.mutate(!published)}>{published ? 'Unpublish' : 'Publish'}</button></>} />
    <div className="filters">
      <div className="field" style={{ flex: '1 1 320px' }}><label htmlFor="cf-lesson">Lesson</label><select className="inp" id="cf-lesson" value={lid} onChange={e => (!dirty || confirm('Discard unsaved changes?')) && onPick(e.target.value)}>
        {lessons.map(l => <option key={l.id} value={l.id}>{l.course_code} · {l.title}</option>)}</select></div>
      <Badge kind={published ? 'good' : 'warn'} dot>{published ? `Published v${c.version} to ${c.course.code} students` : 'Draft — not visible to students'}</Badge>
      {dirty && <Badge kind="warn">Unsaved changes</Badge>}
    </div>
    <p className="xs muted" style={{ margin: 0 }}>Permission: Course lecturer (publish) · Administrator (publish, global defaults) · Student (no access){published && c.published_at ? ` · last published ${fmtDate(c.published_at, true)}` : ''}</p>
    {!c.course.vf_enabled && <Note kind="warn" icon="alert">Virtual faculty is switched off for {c.course.code}. Turn it on in <Link className="link" to={`/l-courses?course=${c.course.id}`}>Course management</Link> so students can see this lesson.</Note>}
    <div className="g g-12">
      <div className="stack">
        <Card title="Lecturers offered for this lesson">
          {fa && <Portrait a={fa} rate={rate} />}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 6, marginTop: 10 }}>{all.map(a => <button key={a.id} className={`fcard ${a.id === focus ? 'sel' : ''}`} style={{ padding: 0, cursor: 'pointer', textAlign: 'left' }} onClick={() => setFocus(a.id)} aria-pressed={a.id === focus} title={a.name}>
            <div className="por" style={{ aspectRatio: '1/1' }}><img src={a.portrait} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: a.calib?.pos }} /></div>
            <div className="xs" style={{ padding: '4px 6px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 4 }}><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.short}</span>{sel.includes(a.id) && <Icon n="check" />}</div></button>)}</div>
          {fa && <div className="row" style={{ marginTop: 10 }}><Switch id="cf-offer" checked={sel.includes(fa.id)} onChange={() => toggle(fa.id)} label={`Offer ${fa.short} for this lesson`} />
            {sel[0] === fa.id ? <Badge kind="teal">Default</Badge> : sel.includes(fa.id) && <button className="btn sm ghost" onClick={() => { setSel(s => [fa.id, ...s.filter(x => x !== fa.id)]); setDirty(true) }}>Make default</button>}</div>}
          {!sel.length && <span className="err"><Icon n="alert" />Offer at least one lecturer.</span>}
        </Card>
        <Card title="Governance"><ul className="small" style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <li>Checkpoints are formative. They never set official grades.</li><li>Graded assessments use lecturer-approved scoring in the Assessment builder.</li>
          <li>The AI identifies concepts; progression follows the rule you set here.</li><li>Every publish and rule change is written to the audit log.</li></ul></Card>
      </div>
      <div className="stack">
        {fa && <Card title="Identity & voice"><div className="g g2">
          <Field label="Display name" htmlFor="cf-name"><input className="inp" id="cf-name" value={fa.name} readOnly /></Field>
          <Field label="Subject specialisation" htmlFor="cf-subj"><input className="inp" id="cf-subj" value={fa.subject} readOnly /></Field>
          <Field label="Voice" htmlFor="cf-voice" hint="Licensed neural voice, rendered per line."><input className="inp" id="cf-voice" value={fa.voice} readOnly /></Field>
          <Field label="Teaching style" htmlFor="cf-style"><input className="inp" id="cf-style" value={fa.style} readOnly /></Field>
          <div className="field"><label htmlFor="cf-rate">Preview speed · {rate.toFixed(2)}×</label><input type="range" id="cf-rate" min={0.7} max={1.3} step={0.05} value={rate} onChange={e => setRate(+e.target.value)} /></div>
        </div><p className="xs muted" style={{ marginTop: 8 }}>Lecturer identities are managed centrally by the Virtual Faculty team. Learners choose their own speaking speed in the classroom.</p></Card>}
        <Card title="Approved material" actions={<span className="xs muted">{c.course.code}</span>}>
          {!c.sources.length ? <Empty icon="file" title="No approved sources">The lecturer can only answer from approved material. Add sources through the content approval workflow.</Empty> :
            <div className="col">{c.sources.map((s: any) => <label key={s.id} className="chk" style={{ justifyContent: 'space-between', border: '1px solid var(--line)', borderRadius: 8, padding: '8px 10px' }}>
              <span className="row" style={{ gap: 8 }}><Icon n="file" /><span><b className="small">{s.title}</b><span className="xs muted" style={{ display: 'block' }}>{s.kind} · {s.approved ? 'approved' : 'pending approval'}</span></span></span>
              <input type="checkbox" checked={s.approved} disabled readOnly /></label>)}</div>}
          <p className="xs muted" style={{ marginTop: 8 }}>The lecturer answers only from approved material. Unapproved files cannot be selected.</p>
        </Card>
        <Card title="Checkpoints & progression rules" actions={<span className="demo-tag">{c.title.slice(0, 40)}</span>}>
          <div className="tbl-wrap"><table className="t"><thead><tr><th>ID</th><th>Question</th><th>Expected concepts</th><th>Type</th><th className="n">Max tries</th><th className="n">Hints</th></tr></thead>
            <tbody>{c.checkpoints.map((cp: any) => <tr key={cp.id}><td className="mono">{cp.id.toUpperCase()}</td><td style={{ minWidth: 220 }}>{cp.question}</td>
              <td>{cp.concepts.map((x: any) => <span key={x.label} className={`b ${x.required ? 'teal' : 'out'}`} style={{ margin: 2 }}>{x.label}{x.required ? ' · req.' : ''}</span>)}</td>
              <td><Badge kind={cp.mandatory ? 'warn' : 'out'}>{cp.mandatory ? 'Mandatory' : 'Optional'}</Badge></td><td className="n">{cp.maxAttempts}</td><td className="n">{cp.hints}</td></tr>)}</tbody></table></div>
          <div className="g g3" style={{ marginTop: 14 }}>
            <Sel id="cf-thr" label="Pass rule" value={pol.threshold} onChange={v => setP('threshold', v)} options={[['required', 'All required concepts, no misconception'], ['all', 'Every listed concept']]} />
            <Sel id="cf-max" label="Retry limit (mandatory)" value={String(pol.maxAttempts || '')} onChange={v => setP('maxAttempts', v ? +v : null)} options={[['', 'As authored per checkpoint'], ['2', '2'], ['3', '3'], ['4', '4'], ['5', '5']]} />
            <Sel id="cf-assist" label="When the limit is reached" value={pol.assisted ? 'assist' : 'hold'} onChange={v => setP('assisted', v === 'assist')} options={[['assist', 'Explain, show model answer, continue & flag'], ['hold', 'Hold for lecturer release']]} />
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <Switch id="cf-hints" checked={pol.hints} onChange={v => setP('hints', v)} label="Allow progressive hints" />
            <Switch id="cf-simpler" checked={pol.simpler} onChange={v => setP('simpler', v)} label="Offer “explain more simply”" />
            <label className="chk"><span className="switch"><input type="checkbox" checked disabled /><span /></span>Never mark correct when the AI service fails (locked)</label>
          </div>
          <p className="xs muted" style={{ marginTop: 8 }}>Edit questions, concepts and hints in the <Link className="link" to={`/l-editor?lesson=${lid}`}>Lesson editor</Link>. A retry-limit override applies to every mandatory checkpoint immediately.</p>
        </Card>
        {fa && <MediaPanel lid={lid} avatar={fa} />}
        {glob && <Card title="Global virtual faculty defaults" actions={!c.can_edit_global && <span className="xs muted">Administrators only</span>}>
          <fieldset disabled={!c.can_edit_global} style={{ border: 0, padding: 0, margin: 0 }}>
            <div className="g g3">
              <Sel id="gl-thr" label="Default pass rule" value={glob.threshold} onChange={v => setGlob({ ...glob, threshold: v })} options={[['required', 'Required concepts'], ['all', 'Every concept']]} />
              <Sel id="gl-eng" label="Evaluation engine" value={glob.engine} onChange={v => setGlob({ ...glob, engine: v })} options={[['auto', 'Auto (Claude, rubric fallback)'], ['claude', 'Claude only'], ['rubric', 'Rubric patterns only']]} />
              <Sel id="gl-max" label="Default retry limit" value={String(glob.max_attempts)} onChange={v => setGlob({ ...glob, max_attempts: +v })} options={[['2', '2'], ['3', '3'], ['4', '4'], ['5', '5']]} />
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <Switch id="gl-h" checked={glob.hints} onChange={v => setGlob({ ...glob, hints: v })} label="Hints on by default" />
              <Switch id="gl-a" checked={glob.assisted} onChange={v => setGlob({ ...glob, assisted: v })} label="Assisted path on by default" />
              <Switch id="gl-m" checked={glob.memory} onChange={v => setGlob({ ...glob, memory: v })} label="Remember learners across lessons" />
            </div>
            {c.can_edit_global && <button className="btn sm pri" style={{ marginTop: 10 }} disabled={saveGlob.isPending} onClick={() => saveGlob.mutate()}><Icon n="save" />Save defaults</button>}
          </fieldset>
        </Card>}
      </div>
    </div>
  </>
}

function Portrait({ a, rate }: { a: any; rate: number }) {
  const ref = useRef<HTMLDivElement>(null); const rig = useRef<Rig | null>(null)
  const [playing, setPlaying] = useState(false); const toast = useToast()
  useEffect(() => {
    if (!ref.current) return
    ref.current.innerHTML = ''; rig.current = mountAvatar(ref.current, a)
    Voice.load(a.id); get(`/api/vf/media/${a.id}`).then(m => Voice.setManifest(a.id, m)).catch(() => { })
    return () => { Voice.cancel(); rig.current?.destroy(); rig.current = null; setPlaying(false) }
  }, [a.id]) // eslint-disable-line
  const test = async () => {
    if (playing) { Voice.cancel(); setPlaying(false); return }
    Voice.unlock(); setPlaying(true)
    try {
      for (const line of previewLines(a)) {
        const ok = await Voice.say(line, await lineHash(a.id, line), { avatarId: a.id, rig: rig.current, rate, voiceHint: a.calib?.voiceHint, pitch: a.calib?.pitch })
        if (!ok) break
      }
    } catch { toast('Voice preview isn’t available in this browser.', true) } finally { setPlaying(false) }
  }
  return <div>
    <div className="stage" style={{ position: 'relative', aspectRatio: '4/3.2', background: 'linear-gradient(180deg,#3A4656,#1C2532)', borderRadius: 10, overflow: 'hidden' }} ref={ref} aria-label={`${a.name}, digital lecturer`} />
    <div className="row" style={{ marginTop: 8 }}><div className="bd" style={{ flex: 1 }}><b className="small">{a.name}</b><div className="xs muted">{a.subject}</div></div>
      <button className="btn sm" onClick={test}><Icon n={playing ? 'pause' : 'vol'} />{playing ? 'Stop' : 'Test voice'}</button></div>
  </div>
}

function MediaPanel({ lid, avatar }: { lid: string; avatar: any }) {
  const toast = useToast()
  const q = useQuery({ queryKey: ['vf-media', lid, avatar.id], queryFn: () => get<any>(`/api/lecturer/vf/media-status?lesson_id=${lid}&avatar_id=${avatar.id}`), refetchInterval: 15000 })
  const req = useMutation({ mutationFn: () => post<any>('/api/lecturer/vf/render', { lesson_id: lid, avatar_id: avatar.id }),
    onSuccess: r => { toast(r.queued || r.requeued ? `Queued ${r.queued + r.requeued} line(s) for rendering` : 'Every line is already queued or rendered'); q.refetch() }, onError: (e: any) => toast(e.message, true) })
  const [all, setAll] = useState(false)
  const d = q.data
  const done = d ? (d.counts.audio || 0) + (d.counts.ready || 0) : 0
  return <Card title={`Voice & video media · ${avatar.short}`} actions={<button className="btn sm teal" disabled={req.isPending} onClick={() => req.mutate()}><Icon n="refresh" />{req.isPending ? 'Requesting…' : 'Request render'}</button>}>
    {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} retry={() => q.refetch()} /> : <>
      <div className="row">{Object.entries(d.counts).filter(([, n]) => n).map(([k, n]) => <Badge key={k} kind={MEDIA_BADGE[k]}>{k === 'audio' ? 'voice ready' : k} · {n as number}</Badge>)}</div>
      <p className="xs muted">{done} of {d.total} lines this lecturer can say in this lesson (for every enrolled learner’s name) have rendered voice. Lines without a clip fall back to the browser voice.</p>
      <div className="tbl-wrap"><table className="t"><thead><tr><th>Line</th><th>Status</th><th className="n">Sec</th></tr></thead>
        <tbody>{d.lines.slice(0, all ? 200 : 8).map((l: any) => <tr key={l.hash}><td className="small" style={{ minWidth: 200 }}>{l.text}{l.error && <div className="xs" style={{ color: 'var(--bad)' }}>{l.error}</div>}</td>
          <td><Badge kind={MEDIA_BADGE[l.status]}>{l.status === 'audio' ? 'voice ready' : l.status}</Badge></td><td className="n">{l.duration ? l.duration.toFixed(1) : '—'}</td></tr>)}</tbody></table></div>
      {d.lines.length > 8 && <button className="btn sm ghost" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show ${Math.min(200, d.lines.length)} lines`}</button>}
    </>}
  </Card>
}
