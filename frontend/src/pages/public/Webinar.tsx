/* Public webinar invitation + self-registration (no sign-in).
   /webinar            general invitation
   /webinar/mba        MBA-track invitation (MBA film, track pre-selection)
   ?name=Priya         personal greeting + pre-filled name
   ?src=whatsapp       where the visitor came from (also utm_* params) */
import { useQuery } from '@tanstack/react-query'
import { FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useParams } from 'react-router-dom'
import { Icon } from '../../components/Icon'
import { ApiError, get, post } from '../../lib/api'
import '../../styles/webinar.css'

const WID = 'ai-quantum-2026'
type Info = { id: string; title: string; presenters: string; kicker: string; summary: string; when: string; starts_at: string | null; duration_min: number; where: string; open: boolean; full: boolean; tracks: string[]; videos: Record<string, string>; posters: Record<string, string> }
type Done = { ref: string; name: string; already: boolean; email: string }

const ROLES: [string, string][] = [['student', 'Student'], ['faculty', 'Faculty / academic'], ['professional', 'Working professional'], ['other', 'Other']]
const YEARS = ['Year 1', 'Year 2', 'Year 3', 'Year 4', 'Postgraduate', 'Alumni']
const OTHER = '__other'

const DISCOVER: [string, string, string][] = [
  ['spark', 'Quantum, demystified', 'How quantum computers tackle certain problems in ways classical machines simply can’t.'],
  ['ai', 'AI finds the patterns', 'Why AI and quantum together are more powerful than either on its own.'],
  ['target', 'Where it changes the world', 'Discovering medicines, modelling our climate, protecting our data and managing our money.'],
  ['cap', 'A new way to learn', 'Delivered by expert faculty, brought to life as AI lecturers who teach, explain and answer your questions.'],
]
const MBA: [string, string, string][] = [
  ['BFSI', 'Banking · Financial Services · Insurance', 'Sharper fraud detection, stronger credit-risk models, quantum-safe security.'],
  ['Retail Management', 'From shelf to supply chain', 'Accurate demand forecasting, dynamic pricing, self-optimising supply chains.'],
  ['Data Science', 'Signal from the noise', 'Models that learn from far more data and find the signals hidden in the noise.'],
  ['Artificial Intelligence', 'Where AI meets the qubit', 'Quantum machine learning and smarter ways to train and optimise models.'],
  ['Finance', 'Markets, risk and pricing', 'Portfolio optimisation, real-time risk analysis, faster pricing of complex instruments.'],
]

export default function Webinar() {
  const { variant } = useParams(); const loc = useLocation()
  const mba = variant === 'mba'
  const sp = useMemo(() => new URLSearchParams(loc.search), [loc.search])
  const guest = (sp.get('name') || '').replace(/[^\p{L}\p{M} .'-]/gu, '').trim().slice(0, 60)
  const q = useQuery({ queryKey: ['webinar', WID], queryFn: () => get<Info>(`/api/webinar/${WID}`), retry: 1 })
  const [done, setDone] = useState<Done | null>(null)
  const formRef = useRef<HTMLDivElement>(null)
  useEffect(() => { document.title = (q.data?.title || 'Webinar') + ' · Register' }, [q.data])
  const d = q.data
  const toForm = () => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  return <div className="wb">
    <header className="wb-hero">
      <div className="wb-glow" aria-hidden />
      <div className="wb-wrap">
        <div className="wb-brands">
          <span className="wb-plate"><img src="/brand/hib_mark.png" alt="" className="mk" /><img src="/brand/hib_word.png" alt="Hibilter IT Systems" className="wd" /></span>
          <span className="amp">&amp;</span>
          <img src="/brand/tuquant.png" alt="TuQuant" className="wb-tq" />
          <span className="pres">present</span>
        </div>
        {guest && <p className="wb-hello">{guest}, your invitation is waiting.</p>}
        <div className="wb-kicker"><i />{d?.kicker || 'LIVE WEBINAR'}{mba && <b>For MBA students</b>}</div>
        <h1>{d ? <>The True Potential of <span className="wb-g">AI</span> and <span className="wb-g">Quantum Computing</span></> : ' '}</h1>
        <div className="wb-meta">
          <span><Icon n="cal" />{d?.when || 'Date & time announcing soon'}</span>
          <span><Icon n="play" />{d?.where || 'Online'}</span>
          <span><Icon n="cap" />Delivered by expert faculty</span>
        </div>
        {mba && <div className="wb-tracks">{MBA.map(t => <span key={t[0]}>{t[0]}</span>)}</div>}
        <button className="wb-cta" onClick={toForm}>Register now<Icon n="arrow" /></button>
      </div>
    </header>

    <main className="wb-wrap wb-main">
      <section className="wb-left">
        <div className="wb-video">
          <video controls playsInline preload="metadata" poster={d?.posters?.[mba ? 'mba' : 'general']}
            src={d?.videos?.[mba ? 'mba' : 'general']} aria-label="Webinar invitation video" />
        </div>
        <h2>What you’ll discover</h2>
        <div className="wb-disc">{DISCOVER.map(([ic, t, s]) => <div key={t}><span className="ic"><Icon n={ic} /></span><div><b>{t}</b><p>{s}</p></div></div>)}</div>
        {mba && <><h2>What it means for your track</h2>
          <div className="wb-mba">{MBA.map(([t, sub, s]) => <div key={t}><b>{t}</b><small>{sub}</small><p>{s}</p></div>)}</div></>}
        <div className="wb-why"><Icon n="ai" /><p><b>Experience the future of learning in one session.</b> This webinar is delivered on our AI learning platform: expert faculty brought to life as AI lecturers who teach, explain and answer your questions — at your own pace, any time.</p></div>
      </section>

      <aside className="wb-right" ref={formRef} id="register">
        {q.isLoading ? <div className="wb-card"><p className="muted">Loading…</p></div>
          : q.error ? <div className="wb-card"><p>{(q.error as ApiError).message}</p><button className="btn" onClick={() => q.refetch()}>Try again</button></div>
          : done ? <Ticket d={d!} done={done} mba={mba} />
          : !d!.open ? <div className="wb-card"><h3>{d!.full ? 'This webinar is full' : 'Registration is closed'}</h3><p className="muted small">Thank you for your interest. Follow Hibilter IT Systems and TuQuant for future sessions.</p></div>
          : <RegForm d={d!} mba={mba} guest={guest} sp={sp} onDone={r => { setDone(r); setTimeout(() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50) }} />}
      </aside>
    </main>
    <footer className="wb-foot wb-wrap">
      <span>Hibilter IT Systems &amp; TuQuant</span>
      <span>We use your details only to manage this webinar and, if you choose, to tell you about future events. To have your registration removed, reply to any webinar email.</span>
    </footer>
  </div>
}

function RegForm({ d, mba, guest, sp, onDone }: { d: Info; mba: boolean; guest: string; sp: URLSearchParams; onDone: (r: Done) => void }) {
  const trackParam = (sp.get('track') || '').toLowerCase()
  const preTrack = d.tracks.find(t => trackParam && t.toLowerCase().includes(trackParam)) || ''
  const [f, setF] = useState({ name: guest, email: '', phone: '', role: mba || preTrack ? 'student' : '', institution: '', programme: preTrack, programmeOther: '', year: '', city: '', question: '', consent: false, updates: false, website: '' })
  const [err, setErr] = useState<Record<string, string>>({}); const [busy, setBusy] = useState(false); const [formErr, setFormErr] = useState<string | null>(null)
  const set = (k: keyof typeof f, v: any) => { setF(x => ({ ...x, [k]: v })); if (err[k]) setErr(e => { const n = { ...e }; delete n[k]; return n }) }
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const v: Record<string, string> = {}
    if (f.name.trim().length < 2) v.name = 'Enter your full name.'
    if (!/^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/.test(f.email.trim())) v.email = 'Enter a valid email address — we’ll send the joining link here.'
    if (f.phone.trim() && !/^\+?[0-9 ()-]{6,24}$/.test(f.phone.trim())) v.phone = 'Enter a valid number with country code, e.g. +230 5xxx xxxx.'
    if (!f.role) v.role = 'Choose one.'
    if (f.institution.trim().length < 2) v.institution = 'Enter your university, college or organisation.'
    if (f.programme === OTHER && !f.programmeOther.trim()) v.programmeOther = 'Enter your programme.'
    if (!f.consent) v.consent = 'Please agree so we can send you the date and joining link.'
    setErr(v); if (Object.keys(v).length) { document.getElementById('wb-' + Object.keys(v)[0])?.focus(); return }
    setBusy(true); setFormErr(null)
    const utm: Record<string, string> = {}; sp.forEach((val, k) => { if (k.startsWith('utm_')) utm[k] = val })
    try {
      const r = await post<Done>(`/api/webinar/${d.id}/register`, {
        name: f.name.trim(), email: f.email.trim(), phone: f.phone.trim() || null, role: f.role, institution: f.institution.trim(),
        programme: (f.programme === OTHER ? f.programmeOther.trim() : f.programme) || null, year_of_study: f.role === 'student' ? f.year || null : null,
        city: f.city.trim() || null, question: f.question.trim() || null, consent: f.consent, consent_updates: f.updates,
        source: sp.get('src') || sp.get('utm_source') || (mba ? 'mba-page' : 'direct'), utm, website: f.website,
      })
      onDone(r)
    } catch (e: any) { setFormErr((e.message || 'Something went wrong.').replace(/^Value error, /, '')) } finally { setBusy(false) }
  }
  const E = ({ k }: { k: string }) => err[k] ? <span className="err" role="alert"><Icon n="alert" />{err[k]}</span> : null
  return <form className="wb-card wb-form" onSubmit={submit} noValidate>
    <div><h3>Reserve your seat</h3><p className="muted small">Free · takes under a minute. Seats are limited.</p></div>
    <div className="field"><label htmlFor="wb-name">Full name *</label><input className={`inp ${err.name ? 'bad' : ''}`} id="wb-name" autoComplete="name" maxLength={200} value={f.name} onChange={e => set('name', e.target.value)} /><E k="name" /></div>
    <div className="field"><label htmlFor="wb-email">Email *</label><input className={`inp ${err.email ? 'bad' : ''}`} id="wb-email" type="email" autoComplete="email" inputMode="email" maxLength={200} value={f.email} onChange={e => set('email', e.target.value)} /><E k="email" /></div>
    <div className="field"><label htmlFor="wb-phone">WhatsApp number <span className="muted">(optional)</span></label><input className={`inp ${err.phone ? 'bad' : ''}`} id="wb-phone" type="tel" autoComplete="tel" inputMode="tel" placeholder="+230 5xxx xxxx" maxLength={24} value={f.phone} onChange={e => set('phone', e.target.value)} /><E k="phone" /></div>
    <fieldset className="field"><legend>I am a *</legend>
      <div className="wb-chips" role="radiogroup" id="wb-role" tabIndex={-1}>{ROLES.map(([k, l]) => <button type="button" role="radio" aria-checked={f.role === k} key={k} className={f.role === k ? 'on' : ''} onClick={() => set('role', k)}>{l}</button>)}</div><E k="role" /></fieldset>
    <div className="field"><label htmlFor="wb-institution">{f.role === 'professional' ? 'Organisation *' : 'University / institution *'}</label><input className={`inp ${err.institution ? 'bad' : ''}`} id="wb-institution" autoComplete="organization" maxLength={200} value={f.institution} onChange={e => set('institution', e.target.value)} /><E k="institution" /></div>
    {f.role !== 'professional' && <div className="field"><label htmlFor="wb-programme">Programme / track</label>
      <select className="inp" id="wb-programme" value={f.programme} onChange={e => set('programme', e.target.value)}>
        <option value="">Choose…</option>{d.tracks.map(t => <option key={t} value={t}>{t}</option>)}<option value={OTHER}>Other programme</option></select>
      {f.programme === OTHER && <input className={`inp ${err.programmeOther ? 'bad' : ''}`} id="wb-programmeOther" style={{ marginTop: 6 }} placeholder="Your programme" maxLength={120} value={f.programmeOther} onChange={e => set('programmeOther', e.target.value)} />}<E k="programmeOther" /></div>}
    {f.role === 'student' && <div className="field"><label htmlFor="wb-year">Year of study</label><select className="inp" id="wb-year" value={f.year} onChange={e => set('year', e.target.value)}><option value="">Choose…</option>{YEARS.map(y => <option key={y}>{y}</option>)}</select></div>}
    <div className="field"><label htmlFor="wb-city">City / country <span className="muted">(optional)</span></label><input className="inp" id="wb-city" autoComplete="address-level2" maxLength={120} value={f.city} onChange={e => set('city', e.target.value)} /></div>
    <div className="field"><label htmlFor="wb-question">A question for the speakers <span className="muted">(optional)</span></label><textarea className="inp" id="wb-question" rows={3} maxLength={600} value={f.question} onChange={e => set('question', e.target.value)} placeholder="What would you most like answered?" /></div>
    <div className="wb-hp" aria-hidden><label>Website<input tabIndex={-1} autoComplete="off" value={f.website} onChange={e => set('website', e.target.value)} /></label></div>
    <label className="wb-check" id="wb-consent" tabIndex={-1}><input type="checkbox" checked={f.consent} onChange={e => set('consent', e.target.checked)} /><span>I agree to be contacted about this webinar (date, joining link, reminders). *</span></label><E k="consent" />
    <label className="wb-check"><input type="checkbox" checked={f.updates} onChange={e => set('updates', e.target.checked)} /><span>Also tell me about future events from Hibilter IT Systems and TuQuant.</span></label>
    {formErr && <div className="note bad" role="alert"><Icon n="alert" /><div>{formErr}</div></div>}
    <button className="wb-cta block" type="submit" disabled={busy}>{busy ? 'Registering…' : 'Register now'}{!busy && <Icon n="arrow" />}</button>
  </form>
}

function Ticket({ d, done, mba }: { d: Info; done: Done; mba: boolean }) {
  const first = done.name.split(/\s+/)[0]
  const link = `${location.origin}/webinar${mba ? '/mba' : ''}`
  const share = `Join me at the live webinar “${d.title}” — ${d.presenters}. Register here: ${link}?src=friend`
  const [copied, setCopied] = useState(false)
  return <div className="wb-card wb-ticket" role="status">
    <div className="wb-ok"><Icon n="checkc" size={28} /></div>
    <h3>{done.already ? `You’re already registered, ${first}` : `You’re in, ${first}!`}</h3>
    <p className="small">{done.already ? 'We’ve updated your details.' : 'Your seat is reserved for'} <b>{d.title}</b>.</p>
    <div className="wb-pass"><div><small>Registration</small><b className="mono">{done.ref}</b></div><div><small>When</small><b>{d.when}</b></div><div><small>Where</small><b>{d.where}</b></div></div>
    <p className="small muted">{d.starts_at ? `We’ll send the joining link to ${done.email}.` : `We’ll send the date, time and joining link to ${done.email} as soon as they’re confirmed.`} Keep your registration code for your records.</p>
    {d.starts_at && <a className="btn block" href={`/api/webinar/${d.id}/calendar.ics`}><Icon n="cal" />Add to calendar</a>}
    <div className="wb-share"><span className="small muted">Invite a friend</span>
      <a className="btn sm" href={`https://wa.me/?text=${encodeURIComponent(share)}`} target="_blank" rel="noopener noreferrer"><Icon n="send" />WhatsApp</a>
      <button className="btn sm" onClick={() => navigator.clipboard?.writeText(`${link}?src=friend`).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800) })}><Icon n={copied ? 'check' : 'file'} />{copied ? 'Copied' : 'Copy link'}</button></div>
  </div>
}
