import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Icon } from '../../components/Icon'
import { Avatar, Badge, Card, Empty, ErrorBox, Field, Loading, Modal, Note, PageHead, useToast } from '../../components/ui'
import { del, get, patch, post } from '../../lib/api'
import { rel } from '../../lib/format'
import { InlineErr, Meta, Pager, qs, Sel, useDebounced, useMeta } from './shared'

type U = { id: string; name: string; email: string; role: string; title: string | null; faculty_id: string | null; faculty: string | null; programme: string | null; student_no: string | null; year: number | null; status: string; locked: boolean; locked_until: string | null; failed_logins: number; last_login_at: string | null; scope: string[] }
type Page = { items: U[]; total: number; counts: Record<string, number>; me: string }
const ROLE_LABEL: Record<string, string> = { student: 'Student', lecturer: 'Lecturer', admin: 'Administrator' }
const PERMS: [string, number | string, number | string, number | string][] = [['View own courses & lessons', 1, 1, 1], ['Take virtual-faculty lessons', 1, 0, 0], ['Submit assignments & quizzes', 1, 0, 0], ['Edit course content', 0, 1, 1], ['Configure & publish digital lecturers', 0, 1, 1], ['Grade & publish marks', 0, 1, 0], ['View class analytics', 0, 1, 1], ['View institution-wide analytics', 0, 0, 1], ['Open individual student records', 0, '◐', '◐'], ['Manage users & roles', 0, 0, 1], ['Export reports', 0, 1, 1], ['Change system settings', 0, 0, 1]]

export default function Users() {
  const meta = useMeta(); const toast = useToast(); const qc = useQueryClient()
  const [q, setQ] = useState(''); const dq = useDebounced(q)
  const [f, setF] = useState({ role: 'all', status: 'all', faculty: 'all' }); const [page, setPage] = useState(1)
  const params = { q: dq, ...f, page, size: 20 }
  const list = useQuery({ queryKey: ['admin-users', params], queryFn: () => get<Page>('/api/admin/users' + qs(params)), placeholderData: p => p })
  const [creating, setCreating] = useState(false)
  const [secret, setSecret] = useState<{ who: string; email: string; password: string } | null>(null)
  const [confirmRole, setConfirmRole] = useState<{ u: U; role: string } | null>(null)
  const [assign, setAssign] = useState<U | null>(null)
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin-users'] })
  const act = useMutation({
    mutationFn: ({ u, a }: { u: U; a: 'suspend' | 'reactivate' | 'unlock' | 'reset-password' }) => post<any>(`/api/admin/users/${u.id}/${a}`, {}),
    onSuccess: (r, { u, a }) => { if (a === 'reset-password') setSecret({ who: u.name, email: u.email, password: r.password }); else toast({ suspend: `${u.name} suspended`, reactivate: `${u.name} reactivated`, unlock: `${u.name} unlocked` }[a]); refresh() },
    onError: (e: any) => toast(e.message, true) })
  const role = useMutation({ mutationFn: ({ u, role }: { u: U; role: string }) => patch(`/api/admin/users/${u.id}/role`, { role }),
    onSuccess: (_, v) => { toast(`${v.u.name} is now ${ROLE_LABEL[v.role]}`); setConfirmRole(null); refresh(); qc.invalidateQueries({ queryKey: ['admin-meta'] }) }, onError: (e: any) => { toast(e.message, true); setConfirmRole(null) } })
  const set = (k: string, v: string) => { setF({ ...f, [k]: v }); setPage(1) }
  const me = list.data?.me
  return <>
    <PageHead no={28} title="Users & roles" sub="Create users, assign roles, enrol students and assign lecturers. Every change is written to the audit log."
      actions={<button className="btn pri" onClick={() => setCreating(true)}><Icon n="plus" />Create user</button>} />
    <div className="card" style={{ padding: '12px 14px' }}><div className="filters">
      <div className="field" style={{ flex: '1 1 220px' }}><label htmlFor="us-q">Search</label><input className="inp" id="us-q" type="search" placeholder="Name, email or student ID" value={q} maxLength={100} onChange={e => { setQ(e.target.value); setPage(1) }} /></div>
      <Sel id="us-r" label="Role" value={f.role} onChange={v => set('role', v)} options={[['all', 'All roles'], ['student', `Students${list.data ? ` (${list.data.counts.student || 0})` : ''}`], ['lecturer', `Lecturers${list.data ? ` (${list.data.counts.lecturer || 0})` : ''}`], ['admin', `Administrators${list.data ? ` (${list.data.counts.admin || 0})` : ''}`]]} />
      <Sel id="us-s" label="Status" value={f.status} onChange={v => set('status', v)} options={[['all', 'All'], ['active', 'Active'], ['suspended', 'Suspended'], ['locked', 'Locked out']]} />
      <Sel id="us-f" label="Faculty" value={f.faculty} onChange={v => set('faculty', v)} options={[['all', 'All'], ...(meta.data?.faculties || []).map(x => [x.id, x.short] as [string, string])]} />
    </div></div>
    <div className="stack" style={{ marginTop: 16 }}>
      <div>{list.isLoading ? <Loading /> : list.error ? <ErrorBox error={list.error} retry={() => list.refetch()} /> : <>
        <div className="tbl-wrap" style={{ opacity: list.isFetching ? .6 : 1 }}><table className="t"><thead><tr><th>User</th><th>Role</th><th className="adm-hide-sm">Scope</th><th>Status</th><th></th></tr></thead>
          <tbody>{list.data!.items.map(u => { const self = u.id === me; return <tr key={u.id}>
            <td><div className="who"><Avatar name={u.name} kind={u.role === 'student' ? 't' : u.role === 'admin' ? 'g' : ''} /><div><div className="nm small">{u.name}{self && <> <Badge kind="info">You</Badge></>}</div><div className="sub">{u.email}</div><div className="sub">{u.last_login_at ? `Last sign-in ${rel(u.last_login_at)}` : 'Never signed in'}</div></div></div></td>
            <td><select className="inp" style={{ width: 'auto' }} aria-label={`Role for ${u.name}`} value={u.role} disabled={self || role.isPending} title={self ? 'You can’t change your own role' : undefined} onChange={e => setConfirmRole({ u, role: e.target.value })}>
              {Object.entries(ROLE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></td>
            <td className="xs adm-hide-sm" style={{ maxWidth: 200 }}>{u.role === 'student' ? <>{u.programme || '—'}{u.year ? `, Y${u.year}` : ''}<div className="muted">{u.scope.join(', ') || 'No enrolments'}</div></> : u.role === 'lecturer' ? <>{u.faculty || '—'}<div className="muted">{u.scope.join(', ') || 'No courses'}</div></> : 'Institution'}</td>
            <td>{u.status === 'active' ? <Badge kind="good">Active</Badge> : <Badge kind="bad">Suspended</Badge>}{u.locked && <div><Badge kind="warn"><Icon n="lock" />Locked</Badge></div>}</td>
            <td><div className="row" style={{ flexWrap: 'nowrap', gap: 4 }}>
              {u.role !== 'admin' && <button className="btn sm" onClick={() => setAssign(u)}>{u.role === 'student' ? 'Enrol' : 'Assign'}</button>}
              {u.locked && <button className="btn sm ghost" disabled={act.isPending} onClick={() => act.mutate({ u, a: 'unlock' })}><Icon n="unlock" />Unlock</button>}
              {!self && (u.status === 'active' ? <button className="btn sm ghost" disabled={act.isPending} onClick={() => confirm(`Suspend ${u.name}? They will be signed out and unable to sign in.`) && act.mutate({ u, a: 'suspend' })}>Suspend</button>
                : <button className="btn sm ghost" disabled={act.isPending} onClick={() => act.mutate({ u, a: 'reactivate' })}>Reactivate</button>)}
              {!self && <button className="btn sm ghost" disabled={act.isPending} onClick={() => confirm(`Reset the password for ${u.name}? A new temporary password will be shown once.`) && act.mutate({ u, a: 'reset-password' })}>Reset</button>}
            </div></td></tr> })}
            {!list.data!.items.length && <tr><td colSpan={5}><Empty icon="users" title="No users match">Try a different search or clear the filters.</Empty></td></tr>}</tbody></table></div>
        <Pager page={page} size={20} total={list.data!.total} onPage={setPage} label="users" />
      </>}</div>
      <Card title="Role permissions" className="adm-perms">
        <div className="tbl-wrap"><table className="t"><thead><tr><th>Permission</th><th>Stu.</th><th>Lec.</th><th>Adm.</th></tr></thead>
          <tbody>{PERMS.map(([p, ...r]) => <tr key={p}><td className="small">{p}</td>{r.map((v, i) => <td key={i}>{v === 1 ? <span style={{ color: 'var(--good)' }}><Icon n="check" /></span> : v === '◐' ? <span className="b warn" title="With logged reason">logged</span> : <span className="faint">—</span>}</td>)}</tr>)}</tbody></table></div>
        <p className="xs muted" style={{ marginTop: 6 }}>“Logged”: allowed only with a recorded reason, written to the audit log. You can’t change your own role or suspend yourself, and the last administrator can’t be removed.</p>
      </Card>
    </div>
    {creating && meta.data && <CreateUser meta={meta.data} onClose={() => setCreating(false)} onDone={(r, name) => { setCreating(false); refresh(); toast(`${name} created`); if (r.password) setSecret({ who: name, email: r.email, password: r.password }) }} />}
    {secret && <Modal title="Temporary password" onClose={() => setSecret(null)} footer={<button className="btn pri" onClick={() => setSecret(null)}>I’ve shared it securely</button>}>
      <Note kind="warn" icon="lock">This password is shown <b>once</b> and isn’t stored in readable form. Share it with {secret.who} through a secure channel; they should change it after signing in.</Note>
      <dl className="kv" style={{ marginTop: 10 }}><dt>Email</dt><dd className="mono">{secret.email}</dd><dt>Password</dt><dd><span className="mono" style={{ fontSize: 16, userSelect: 'all' }}>{secret.password}</span> <button className="btn sm" onClick={() => navigator.clipboard?.writeText(secret.password).then(() => toast('Copied'))}>Copy</button></dd></dl>
    </Modal>}
    {confirmRole && <Modal title="Change role?" onClose={() => setConfirmRole(null)} footer={<><button className="btn" onClick={() => setConfirmRole(null)}>Cancel</button><button className="btn pri" disabled={role.isPending} onClick={() => role.mutate(confirmRole)}>{role.isPending ? 'Saving…' : 'Change role'}</button></>}>
      <p className="small">Change <b>{confirmRole.u.name}</b> from {ROLE_LABEL[confirmRole.u.role]} to <b>{ROLE_LABEL[confirmRole.role]}</b>? Their access changes at their next request. This is written to the audit log.</p>
    </Modal>}
    {assign && meta.data && <AssignModal u={assign} meta={meta.data} onClose={() => setAssign(null)} onDone={m => { toast(m); setAssign(null); refresh(); qc.invalidateQueries({ queryKey: ['admin-structure'] }) }} />}
  </>
}

function CreateUser({ meta, onClose, onDone }: { meta: Meta; onClose: () => void; onDone: (r: any, name: string) => void }) {
  const [f, setF] = useState({ name: '', email: '', role: 'student', faculty_id: '', programme_id: '', year: '1', title: '', pwMode: 'gen', password: '' })
  const [errs, setErrs] = useState<Record<string, string>>({}); const [serr, setSerr] = useState<string | null>(null)
  const m = useMutation({ mutationFn: () => post<any>('/api/admin/users', { name: f.name.trim(), email: f.email.trim(), role: f.role, title: f.title.trim() || null, faculty_id: f.faculty_id || null, programme_id: f.role === 'student' ? f.programme_id || null : null, year: f.role === 'student' ? Number(f.year) : null, password: f.pwMode === 'set' ? f.password : null }),
    onSuccess: r => onDone(r, f.name.trim()), onError: (e: any) => { if (e.status === 409) setErrs({ email: e.message }); else setSerr(e.message) } })
  const progs = meta.programmes.filter(p => !f.faculty_id || p.faculty_id === f.faculty_id)
  const submit = () => {
    const e: Record<string, string> = {}
    if (f.name.trim().length < 2) e.name = 'Enter a name.'
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email.trim())) e.email = 'Enter a valid email.'
    if (f.role === 'student' && !f.programme_id) e.programme = 'Choose the student’s programme.'
    if (f.role === 'lecturer' && !f.faculty_id) e.faculty = 'Choose the lecturer’s faculty.'
    if (f.pwMode === 'set' && f.password.length < 10) e.password = 'Use at least 10 characters.'
    setErrs(e); if (Object.keys(e).length) return; setSerr(null); m.mutate()
  }
  return <Modal title="Create user" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn pri" disabled={m.isPending} onClick={submit}>{m.isPending ? 'Creating…' : 'Create'}</button></>}>
    <div className="col">
      <Field label="Full name" htmlFor="nu-n" error={errs.name}><input className={`inp ${errs.name ? 'bad' : ''}`} id="nu-n" maxLength={200} value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></Field>
      <Field label="Email" htmlFor="nu-e" error={errs.email}><input className={`inp ${errs.email ? 'bad' : ''}`} id="nu-e" type="email" maxLength={200} value={f.email} onChange={e => setF({ ...f, email: e.target.value })} /></Field>
      <div className="g g2">
        <Sel id="nu-r" label="Role" value={f.role} onChange={v => setF({ ...f, role: v })} options={[['student', 'Student'], ['lecturer', 'Lecturer'], ['admin', 'Administrator']]} />
        <Field label="Faculty" htmlFor="nu-f" error={errs.faculty}><select className="inp" id="nu-f" value={f.faculty_id} onChange={e => setF({ ...f, faculty_id: e.target.value, programme_id: '' })}><option value="">{f.role === 'admin' ? 'Institution-wide' : 'Choose…'}</option>{meta.faculties.map(x => <option key={x.id} value={x.id}>{x.short}</option>)}</select></Field>
        {f.role === 'student' && <><Field label="Programme" htmlFor="nu-p" error={errs.programme}><select className="inp" id="nu-p" value={f.programme_id} onChange={e => setF({ ...f, programme_id: e.target.value })}><option value="">Choose…</option>{progs.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
          <Sel id="nu-y" label="Year" value={f.year} onChange={v => setF({ ...f, year: v })} options={[['1', 'Year 1'], ['2', 'Year 2'], ['3', 'Year 3'], ['4', 'Year 4']]} /></>}
        {f.role !== 'student' && <Field label="Job title (optional)" htmlFor="nu-t"><input className="inp" id="nu-t" maxLength={200} value={f.title} onChange={e => setF({ ...f, title: e.target.value })} /></Field>}
      </div>
      <Sel id="nu-pw" label="Initial password" value={f.pwMode} onChange={v => setF({ ...f, pwMode: v })} options={[['gen', 'Generate a strong password (shown once)'], ['set', 'Set a password now']]} />
      {f.pwMode === 'set' && <Field label="Password" htmlFor="nu-pp" error={errs.password} hint="At least 10 characters"><input className={`inp ${errs.password ? 'bad' : ''}`} id="nu-pp" type="password" autoComplete="new-password" value={f.password} onChange={e => setF({ ...f, password: e.target.value })} /></Field>}
      <InlineErr msg={serr} />
    </div></Modal>
}

function AssignModal({ u, meta, onClose, onDone }: { u: U; meta: Meta; onClose: () => void; onDone: (m: string) => void }) {
  const student = u.role === 'student'
  const courses = meta.courses.filter(c => c.status !== 'archived')
  const avail = student ? courses.filter(c => !u.scope.includes(c.code)) : courses
  const [cid, setCid] = useState(avail[0]?.id || ''); const [err, setErr] = useState<string | null>(null)
  const go = useMutation({ mutationFn: () => student ? post(`/api/admin/users/${u.id}/enrolments`, { course_id: cid }) : patch(`/api/admin/courses/${cid}`, { lecturer_id: u.id }),
    onSuccess: () => onDone(student ? `${u.name} enrolled in ${meta.courses.find(c => c.id === cid)?.code}` : `${u.name} assigned to ${meta.courses.find(c => c.id === cid)?.code}`), onError: (e: any) => setErr(e.message) })
  const withdraw = useMutation({ mutationFn: (id: string) => del(`/api/admin/users/${u.id}/enrolments/${id}`), onSuccess: () => onDone('Enrolment withdrawn'), onError: (e: any) => setErr(e.message) })
  const enrolled = courses.filter(c => u.scope.includes(c.code))
  return <Modal title={`${student ? 'Enrol' : 'Assign'} ${u.name}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn pri" disabled={go.isPending || !cid} onClick={() => go.mutate()}>{go.isPending ? 'Saving…' : student ? 'Enrol' : 'Assign as lecturer'}</button></>}>
    <div className="col">
      {avail.length ? <Sel id="en-c" label="Course" value={cid} onChange={setCid} options={avail.map(c => [c.id, `${c.code} · ${c.title}`] as [string, string])} hint={student ? undefined : 'Replaces the course’s current lecturer.'} /> : <p className="small muted">Already enrolled in every active course.</p>}
      {student && enrolled.length > 0 && <><div className="eyebrow">Current enrolments</div><div className="list">{enrolled.map(c => <div className="li" key={c.id}><div className="bd small"><b>{c.code}</b> {c.title}</div><button className="btn sm ghost" disabled={withdraw.isPending} onClick={() => confirm(`Withdraw ${u.name} from ${c.code}? Their work is kept.`) && withdraw.mutate(c.id)}>Withdraw</button></div>)}</div></>}
      <InlineErr msg={err} />
    </div></Modal>
}
