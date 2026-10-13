import { useQuery } from '@tanstack/react-query'
import { FormEvent, useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { Icon } from '../components/Icon'
import { Modal } from '../components/ui'
import { get } from '../lib/api'
import { HOME, Role, useAuth } from '../lib/auth'

type Demo = { enabled: boolean; password?: string; accounts?: Record<Role, string> }

export default function Login() {
  const { me, login } = useAuth()
  const nav = useNavigate(); const loc = useLocation() as any
  const demo = useQuery({ queryKey: ['demo-accounts'], queryFn: () => get<Demo>('/api/auth/demo-accounts'), retry: false })
  const [role, setRole] = useState<Role>('student')
  const [email, setEmail] = useState(''); const [pw, setPw] = useState('')
  const [show, setShow] = useState(false); const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<{ email?: string; pw?: string; form?: string }>({})
  const [forgot, setForgot] = useState(false)
  if (me) return <Navigate to={loc.state?.from || HOME[me.role]} replace />
  const pick = (r: Role) => { setRole(r); if (demo.data?.accounts) { setEmail(demo.data.accounts[r]); setPw(demo.data.password || '') } }
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const v: typeof err = {}
    if (!/^\S+@\S+\.\S+$/.test(email)) v.email = 'Enter your university email address.'
    if (!pw) v.pw = 'Enter your password.'
    setErr(v); if (Object.keys(v).length) return
    setBusy(true)
    try { const u = await login(email, pw); nav(loc.state?.from || HOME[u.role], { replace: true }) }
    catch (e: any) { setErr({ form: e.message }) } finally { setBusy(false) }
  }
  return <div className="login" style={{ minHeight: '100vh' }}>
    <section className="art">
      <img src="/brand/uom.png" alt="University of Mauritius" style={{ height: 46, width: 'auto', alignSelf: 'flex-start' }} />
      <div><div className="eyebrow" style={{ color: '#7FD8D2' }}>Hibilter AI Learning Platform</div><h1 style={{ marginTop: 10 }}>Learn with lecturers who ask, listen and adapt.</h1></div>
      <p>One place for courses, assessment and AI digital faculty that teach interactively — with lecturers and leadership kept in control.</p>
      <div className="feat">
        <div><Icon n="cap" /><span>AI digital lecturers that pause, ask questions and wait for your answer</span></div>
        <div><Icon n="ai" /><span>A study assistant grounded in approved course material, with sources</span></div>
        <div><Icon n="chart" /><span>Learning analytics for lecturers and academic leadership</span></div>
      </div>
      <div className="row" style={{ marginTop: 'auto', gap: 10 }}><img src="/brand/hibilter.png" alt="Hibilter" style={{ height: 30, background: '#fff', borderRadius: 6, padding: 3 }} />
        <span className="small" style={{ color: 'var(--on-navy-muted)' }}>Hibilter × University of Mauritius · synthetic data only</span></div>
    </section>
    <section className="form">
      <form className="box" onSubmit={submit} noValidate>
        <div>{demo.data?.enabled && <span className="demo-tag">Demo environment</span>}<h2 style={{ marginTop: 10, fontSize: 24 }}>Sign in</h2>
          <p className="muted small">{demo.data?.enabled ? 'Choose a demo role to fill in its account.' : 'Use your University account.'}</p></div>
        {demo.data?.enabled && <div className="rolepick" role="radiogroup" aria-label="Demo access">
          {([['student', 'cap', 'Student'], ['lecturer', 'book', 'Lecturer'], ['admin', 'bldg', 'Administrator']] as const).map(([k, ic, l]) =>
            <button key={k} type="button" role="radio" aria-checked={role === k} className={role === k && email ? 'on' : ''} onClick={() => pick(k)}><Icon n={ic} size={20} />{l}</button>)}
        </div>}
        <div className="field"><label htmlFor="lg-email">University email</label>
          <input className={`inp ${err.email ? 'bad' : ''}`} id="lg-email" type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} />
          {err.email && <span className="err"><Icon n="alert" />{err.email}</span>}</div>
        <div className="field"><label htmlFor="lg-pw">Password</label>
          <div className="pw"><input className={`inp ${err.pw ? 'bad' : ''}`} id="lg-pw" type={show ? 'text' : 'password'} autoComplete="current-password" value={pw} onChange={e => setPw(e.target.value)} />
            <button type="button" onClick={() => setShow(!show)} aria-label={show ? 'Hide password' : 'Show password'}><Icon n={show ? 'eyeoff' : 'eye'} /></button></div>
          {err.pw && <span className="err"><Icon n="alert" />{err.pw}</span>}</div>
        <div className="row sb small"><span /><button type="button" className="btn ghost sm" onClick={() => setForgot(true)}>Forgot password?</button></div>
        {err.form && <div className="note bad" role="alert"><Icon n="alert" /><div>{err.form}</div></div>}
        <button className="btn pri lg block" type="submit" disabled={busy}><Icon n="lock" />{busy ? 'Signing in…' : 'Sign in'}</button>
        <p className="xs muted" style={{ textAlign: 'center' }}>AI-generated content is labelled throughout. AI never sets official grades.</p>
      </form>
    </section>
    {forgot && <Modal title="Reset your password" onClose={() => setForgot(false)} footer={<button className="btn pri" onClick={() => setForgot(false)}>OK</button>}>
      <p>Password resets go through the University IT Helpdesk while single sign-on is being connected. Contact the helpdesk with your student or staff number.</p>
    </Modal>}
  </div>
}
