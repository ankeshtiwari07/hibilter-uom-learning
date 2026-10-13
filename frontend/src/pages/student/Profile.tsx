import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Icon } from '../../components/Icon'
import { Avatar, Badge, Card, ErrorBox, Field, Loading, PageHead, Seg, Switch, useToast } from '../../components/ui'
import { get, patch, post } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { fmtDate } from '../../lib/format'
import { errText } from './shared'

type Prof = { name: string; first: string; email: string; student_no?: string; year?: number; status: string; programme?: string; level?: string; faculty?: string; last_login_at?: string
  enrolments: { course_id: string; code: string; title: string; credits: number; term: string; status: string; progress: number }[]
  prefs: Record<string, any>; privacy: { ai_memory: boolean; assistant_history: boolean; analytics: boolean } }

export default function Profile() {
  const { me, setPrefs, refresh } = useAuth(); const toast = useToast(); const qc = useQueryClient()
  const q = useQuery({ queryKey: ['s-profile'], queryFn: () => get<Prof>('/api/student/profile') })
  const sp = useMutation({ mutationFn: (b: Record<string, any>) => patch('/api/student/prefs', b),
    onSuccess: () => { refresh(); qc.invalidateQueries({ queryKey: ['s-profile'] }); toast('Saved') }, onError: (e: any) => toast(errText(e), true) })
  if (q.isLoading) return <Loading />
  if (q.error) return <ErrorBox error={q.error} retry={() => q.refetch()} />
  const p = q.data!
  const pr = me?.prefs || {}
  const notif = { email: true, push: false, digest: true, ...(pr.notifications || {}) }
  const save = (k: string, v: any, msg = 'Saved') => { setPrefs({ [k]: v }); toast(msg) }
  const priv = p.privacy
  return <>
    <PageHead no={13} title="Profile & settings" sub="Your details, enrolment, notifications, language, accessibility and privacy." />
    <div className="g g-12"><div className="stack">
      <div className="card" style={{ textAlign: 'center' }}><div style={{ display: 'grid', placeItems: 'center' }}><Avatar name={p.name} kind="t" size={72} /></div>
        <h2 style={{ marginTop: 10 }}>{p.name}</h2><p className="small muted">{p.student_no} · synthetic profile</p>
        <dl className="kv" style={{ textAlign: 'left', marginTop: 14 }}><dt>Email</dt><dd className="small" style={{ wordBreak: 'break-all' }}>{p.email}</dd><dt>Programme</dt><dd>{p.programme || '—'}</dd>
          <dt>Faculty</dt><dd>{p.faculty || '—'}</dd><dt>Year</dt><dd>{p.year ?? '—'}{p.level ? ` · ${p.level}` : ''}</dd><dt>Status</dt><dd><Badge kind={p.status === 'active' ? 'good' : 'bad'}>{p.status === 'active' ? 'Enrolled' : p.status}</Badge></dd>
          <dt>Last sign-in</dt><dd className="small">{fmtDate(p.last_login_at, true)}</dd></dl>
        <p className="xs muted" style={{ marginTop: 10, textAlign: 'left' }}>Identity details come from the student record and can’t be edited here. Contact the academic office to correct them.</p></div>
      <Card title="Enrolments">{p.enrolments.length ? <div className="list">{p.enrolments.map(e => <div className="li" key={e.course_id}><div className="ic"><Icon n="book" /></div>
        <div className="bd"><div className="tt small">{e.code} · {e.title}</div><div className="ds">{e.credits ? `${e.credits} credits` : 'Short course'} · {e.term} · {e.progress}% complete</div></div></div>)}</div> : <p className="small muted">No enrolments.</p>}</Card>
    </div>
      <div className="stack">
        <Card title="Notifications"><div className="col">{([['email', 'Email me about deadlines and grades'], ['push', 'Mobile push notifications'], ['digest', 'Weekly progress digest']] as const).map(([k, l]) =>
          <Switch key={k} id={`n-${k}`} checked={!!notif[k]} label={l} onChange={v => save('notifications', { ...notif, [k]: v }, 'Notification preference saved')} />)}</div></Card>
        <Card title="Language & accessibility"><div className="g g2">
          <Field label="Interface language" htmlFor="pf-lang"><select className="inp" id="pf-lang" value={pr.language || 'English'} onChange={e => save('language', e.target.value, 'Language preference saved (the interface stays in English for now)')}>
            {['English', 'Français', 'Kreol Morisien (roadmap)'].map(l => <option key={l}>{l}</option>)}</select></Field>
          <Field label="Text size" htmlFor="pf-fs"><Seg options={[['normal', 'Standard'], ['large', 'Large']]} value={pr.textSize === 'large' ? 'large' : 'normal'} onChange={v => save('textSize', v)} /></Field>
          <Field label="Theme" htmlFor="pf-th"><Seg options={[['system', 'System'], ['light', 'Light'], ['dark', 'Dark']]} value={pr.theme || 'system'} onChange={v => save('theme', v)} /></Field></div>
          <div className="col" style={{ marginTop: 12 }}>
            <Switch id="p-cap" checked={pr.captions !== false} label="Captions on by default in lessons and the virtual classroom" onChange={v => save('captions', v)} />
            <Switch id="p-tr" checked={!!pr.transcript} label="Show live transcript in the virtual classroom" onChange={v => sp.mutate({ transcript: v })} />
            <Switch id="p-rm" checked={!!pr.reducedMotion} label="Reduce motion (calmer avatar and transitions)" onChange={v => save('reducedMotion', v)} />
          </div></Card>
        <Card title="Privacy & AI" actions={<Icon n="shield" />}><div className="col">
          <Switch id="pv-mem" checked={priv.ai_memory} label="Let AI tutors remember earlier conversations (off by default)" onChange={v => sp.mutate({ privacy: { ai_memory: v } })} />
          <Switch id="pv-hist" checked={priv.assistant_history} label="Show my study-assistant history on this device" onChange={v => sp.mutate({ privacy: { assistant_history: v } })} />
          <Switch id="pv-an" checked={priv.analytics} label="Use my activity for personal recommendations" onChange={v => sp.mutate({ privacy: { analytics: v } })} /></div>
          <p className="xs muted" style={{ marginTop: 8 }}>AI features never set grades. Your questions and checkpoint answers are visible to your course lecturers for teaching purposes and kept under the university’s retention policy. Changes to these choices are logged.</p></Card>
        <PasswordForm />
      </div></div>
  </>
}

function PasswordForm() {
  const toast = useToast()
  const [f, setF] = useState({ c: '', n: '', r: '' }); const [err, setErr] = useState<string | null>(null)
  const m = useMutation({ mutationFn: () => post('/api/auth/password', { current: f.c, new: f.n }), onSuccess: () => { setF({ c: '', n: '', r: '' }); setErr(null); toast('Password updated') }, onError: (e: any) => setErr(errText(e)) })
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const msg = !f.c ? 'Enter your current password.' : f.n.length < 12 || !/\d/.test(f.n) || !/[^\w\s]/.test(f.n) ? 'New password needs 12+ characters, including a number and a symbol.' : f.n !== f.r ? 'The new passwords don’t match.' : f.n === f.c ? 'Choose a password different from the current one.' : ''
    setErr(msg || null); if (!msg) m.mutate()
  }
  return <Card title="Password"><form className="g g3" noValidate onSubmit={submit}>
    <Field label="Current" htmlFor="pw-c"><input className="inp" type="password" id="pw-c" autoComplete="current-password" value={f.c} onChange={e => setF({ ...f, c: e.target.value })} /></Field>
    <Field label="New" htmlFor="pw-n" hint="12+ characters, a number and a symbol"><input className="inp" type="password" id="pw-n" autoComplete="new-password" value={f.n} onChange={e => setF({ ...f, n: e.target.value })} /></Field>
    <Field label="Confirm new" htmlFor="pw-r"><input className="inp" type="password" id="pw-r" autoComplete="new-password" value={f.r} onChange={e => setF({ ...f, r: e.target.value })} /></Field>
    {err && <span className="err small" role="alert" style={{ gridColumn: '1/-1', color: 'var(--bad)' }}><Icon n="alert" /> {err}</span>}
    <div style={{ gridColumn: '1/-1' }}><button className="btn pri" type="submit" disabled={m.isPending}>{m.isPending ? 'Updating…' : 'Update password'}</button></div></form>
    <p className="xs muted" style={{ marginTop: 8 }}>In production, passwords are managed by the university’s identity provider.</p></Card>
}
