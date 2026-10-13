import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Icon } from '../../components/Icon'
import { Badge, Card, Empty, ErrorBox, Field, Loading, Note, PageHead, Switch, Tabs, useToast } from '../../components/ui'
import { download, get, put } from '../../lib/api'
import { fmtDate } from '../../lib/format'
import { InlineErr, Pager, qs, Sel, useDebounced } from './shared'

type Settings = { ai: { assistant: boolean; label_ai: boolean; retention_days: number; lecturer_see_answers: boolean; ai_sets_grades: boolean }; vf: { hints: boolean; assisted: boolean; threshold: string; engine: string; memory: boolean; max_attempts: number }; risk: { activity_below: number; inactive_days: number; avg_below: number; overdue_min: number; completion_below: number; vf_assisted: boolean } }
type AuditRow = { id: number; ts: string; actor: string; action: string; kind: string; obj: string; reason: string | null; detail: Record<string, any>; hash: string }
const KIND_BADGE: Record<string, string> = { grade: 'warn', export: 'info', access: 'gold', system: 'bad', content: 'teal', auth: 'out', data: 'info' }
const KINDS: [string, string][] = [['all', 'All'], ['content', 'Content publication'], ['grade', 'Grade changes'], ['export', 'Report exports'], ['access', 'Access & roles'], ['data', 'Data access'], ['auth', 'Sign-ins'], ['system', 'System']]

export default function SettingsPage() {
  const [tab, setTab] = useState('audit')
  return <>
    <PageHead no={29} title="Settings & audit log" sub="Institution AI and virtual-faculty policies, support rules, and the tamper-evident audit trail." />
    <Tabs value={tab} onChange={setTab} tabs={[['audit', 'Audit log'], ['ai', 'AI & data'], ['vf', 'Virtual faculty defaults'], ['risk', 'Support rules']]} />
    <div style={{ marginTop: 14 }}>{tab === 'audit' ? <Audit /> : <SettingsForm k={tab as 'ai' | 'vf' | 'risk'} />}</div>
  </>
}

function Audit() {
  const toast = useToast()
  const [f, setF] = useState({ kind: 'all', actor: '', from: '', to: '', q: '' }); const [page, setPage] = useState(1)
  const da = useDebounced(f.actor), dq = useDebounced(f.q)
  const bad = f.from && f.to && f.from > f.to ? 'The start date is after the end date.' : null
  const params = { kind: f.kind, actor: da, from: f.from, to: f.to, q: dq }
  const list = useQuery({ queryKey: ['admin-audit', params, page], enabled: !bad, queryFn: () => get<{ items: AuditRow[]; total: number; kinds: Record<string, number> }>('/api/admin/audit' + qs({ ...params, page, size: 25 })), placeholderData: p => p })
  const [verify, setVerify] = useState<{ ok: boolean; checked: number | null; first_broken_id: number | null; total: number; verified_at: string } | null>(null)
  const v = useMutation({ mutationFn: () => get<any>('/api/admin/audit/verify'), onSuccess: setVerify, onError: (e: any) => toast(e.message, true) })
  const [exporting, setExporting] = useState(false)
  const [open, setOpen] = useState<number | null>(null)
  const set = (k: string, val: string) => { setF({ ...f, [k]: val }); setPage(1) }
  const exportCsv = async () => { setExporting(true); try { await download('/api/admin/audit.csv' + qs(params), 'audit-log.csv'); toast('Audit log exported — the export itself is logged') } catch (e: any) { toast(e.message, true) } finally { setExporting(false) } }
  return <div className="stack">
    <div className="card" style={{ padding: '12px 14px' }}>
      <div className="chips" role="group" aria-label="Event type">{KINDS.map(([k, l]) => <button key={k} className={`chip ${f.kind === k ? 'on' : ''}`} aria-pressed={f.kind === k} onClick={() => set('kind', k)}>{l}{k !== 'all' && list.data?.kinds[k] ? ` · ${list.data.kinds[k]}` : ''}</button>)}</div>
      <div className="filters" style={{ marginTop: 10 }}>
        <Field label="Who" htmlFor="au-a"><input className="inp" id="au-a" placeholder="Actor name" maxLength={100} value={f.actor} onChange={e => set('actor', e.target.value)} /></Field>
        <Field label="Search" htmlFor="au-q"><input className="inp" id="au-q" placeholder="Action, object or reason" maxLength={100} value={f.q} onChange={e => set('q', e.target.value)} /></Field>
        <Field label="From" htmlFor="au-f"><input className={`inp ${bad ? 'bad' : ''}`} id="au-f" type="date" value={f.from} onChange={e => set('from', e.target.value)} /></Field>
        <Field label="To" htmlFor="au-t"><input className={`inp ${bad ? 'bad' : ''}`} id="au-t" type="date" value={f.to} onChange={e => set('to', e.target.value)} /></Field>
        <span className="sp" />
        <button className="btn" disabled={v.isPending} onClick={() => v.mutate()}><Icon n="shield" />{v.isPending ? 'Verifying…' : 'Verify integrity'}</button>
        <button className="btn" disabled={exporting || !!bad} onClick={exportCsv}><Icon n="download" />{exporting ? 'Exporting…' : 'Export log'}</button>
      </div><InlineErr msg={bad} />
    </div>
    {verify && (verify.ok ? <Note kind="teal" icon="checkc"><b>Integrity verified.</b> All {verify.checked} entries form an unbroken hash chain (checked {fmtDate(verify.verified_at, true)}).</Note>
      : <Note kind="bad" icon="alert"><b>Integrity check failed.</b> The hash chain breaks at entry <span className="mono">#{verify.first_broken_id}</span> — that row or the one before it was altered or removed outside the application. Escalate to the information-security officer.</Note>)}
    {bad ? null : list.isLoading ? <Loading /> : list.error ? <ErrorBox error={list.error} retry={() => list.refetch()} /> : <>
      <div className="tbl-wrap" style={{ opacity: list.isFetching ? .6 : 1 }}><table className="t"><thead><tr><th>Time</th><th>Who</th><th>Action</th><th>Object</th><th>Type</th></tr></thead>
        <tbody>{list.data!.items.map(a => <tr key={a.id} onClick={() => setOpen(open === a.id ? null : a.id)} style={{ cursor: 'pointer' }}>
          <td className="mono xs" style={{ whiteSpace: 'nowrap' }}>#{a.id}<div>{new Date(a.ts).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</div></td>
          <td className="small">{a.actor}</td>
          <td><b className="small">{a.action}</b>{a.reason && <div className="xs muted">Reason: {a.reason}</div>}</td>
          <td className="small" style={{ maxWidth: 320 }}>{a.obj}{open === a.id && <div className="xs muted mono" style={{ marginTop: 4, wordBreak: 'break-all' }}>{Object.keys(a.detail).length > 0 && <div>{JSON.stringify(a.detail)}</div>}hash {a.hash.slice(0, 16)}…</div>}</td>
          <td><Badge kind={KIND_BADGE[a.kind] || 'out'}>{a.kind}</Badge></td></tr>)}
          {!list.data!.items.length && <tr><td colSpan={5}><Empty title="No events of this type yet" /></td></tr>}</tbody></table></div>
      <Pager page={page} size={25} total={list.data!.total} onPage={setPage} label="entries" />
      <p className="xs muted">Append-only: each entry’s hash covers the previous entry, so any edit or deletion breaks the chain. Click a row for details.</p>
    </>}
  </div>
}

function SettingsForm({ k }: { k: 'ai' | 'vf' | 'risk' }) {
  const qc = useQueryClient(); const toast = useToast()
  const q = useQuery({ queryKey: ['admin-settings'], queryFn: () => get<Settings>('/api/admin/settings') })
  const [v, setV] = useState<any>(null); const [err, setErr] = useState<string | null>(null)
  useEffect(() => { if (q.data) setV({ ...q.data[k] }) }, [q.data, k])
  const save = useMutation({ mutationFn: () => put(`/api/admin/settings/${k}`, v), onSuccess: () => { toast('Settings saved — recorded in the audit log'); setErr(null); qc.invalidateQueries({ queryKey: ['admin-settings'] }); qc.invalidateQueries({ queryKey: ['admin-risk'] }) }, onError: (e: any) => setErr(e.message) })
  if (q.isLoading || !v) return q.error ? <ErrorBox error={q.error} retry={() => q.refetch()} /> : <Loading />
  const dirty = JSON.stringify(v) !== JSON.stringify(q.data![k])
  const num = (key: string, label: string, min: number, max: number, hint?: string) => <Field label={label} htmlFor={`st-${key}`} hint={hint}><input className="inp" id={`st-${key}`} type="number" min={min} max={max} value={v[key]} onChange={e => setV({ ...v, [key]: e.target.value === '' ? '' : Number(e.target.value) })} /></Field>
  const validate = () => {
    const ranges: Record<string, [number, number]> = { retention_days: [30, 3650], max_attempts: [1, 5], activity_below: [0, 100], inactive_days: [0, 90], avg_below: [0, 100], overdue_min: [0, 20], completion_below: [0, 100] }
    for (const [key, [lo, hi]] of Object.entries(ranges)) if (key in v && (typeof v[key] !== 'number' || v[key] < lo || v[key] > hi)) return `${key.replace(/_/g, ' ')} must be between ${lo} and ${hi}.`
    return null
  }
  return <Card>
    {k === 'ai' && <div className="g g2">
      <div className="col"><h3 style={{ fontSize: 14 }}>AI services</h3>
        <Switch id="st-assist" checked={v.assistant} onChange={x => setV({ ...v, assistant: x })} label="Study assistant available to learners (grounded in approved course material only)" />
        <Locked id="st-label" label="Label all AI-generated content (always on)" />
        <Locked id="st-grades" label="AI never sets official grades (always on)" />
        <p className="xs muted">The last two are university policy and can’t be switched off.</p></div>
      <div className="col"><h3 style={{ fontSize: 14 }}>Data & privacy</h3>
        {num('retention_days', 'Keep checkpoint answers and assistant transcripts for (days)', 30, 3650, 'Then aggregated and deleted. 30–3650 days.')}
        <Switch id="st-see" checked={v.lecturer_see_answers} onChange={x => setV({ ...v, lecturer_see_answers: x })} label="Allow lecturers to see individual checkpoint answers" /></div>
    </div>}
    {k === 'vf' && <div className="g g2">
      <div className="col"><h3 style={{ fontSize: 14 }}>Checkpoint defaults</h3>
        <Sel id="st-th" label="Pass threshold" value={v.threshold} onChange={x => setV({ ...v, threshold: x })} options={[['required', 'All required concepts present'], ['all', 'All concepts present (strict)']]} />
        {num('max_attempts', 'Attempts before the assisted path', 1, 5)}
        <Switch id="st-hints" checked={v.hints} onChange={x => setV({ ...v, hints: x })} label="Offer hints after a partial answer" />
        <Switch id="st-assisted" checked={v.assisted} onChange={x => setV({ ...v, assisted: x })} label="Offer the assisted path (lecturer reviews it)" /></div>
      <div className="col"><h3 style={{ fontSize: 14 }}>Engine & memory</h3>
        <Sel id="st-eng" label="Answer-checking engine" value={v.engine} onChange={x => setV({ ...v, engine: x })} options={[['auto', 'Automatic — AI with rubric fallback'], ['rubric', 'Rubric only (offline)'], ['claude', 'AI only (errors pause the lesson)']]} />
        <Switch id="st-mem" checked={v.memory} onChange={x => setV({ ...v, memory: x })} label="Cross-session learner memory (requires learner consent)" />
        <p className="xs muted">Defaults apply to new lessons; lecturers can tighten them per lesson.</p></div>
    </div>}
    {k === 'risk' && <div className="col">
      <Note>These transparent rules decide who appears on <b>Learners for follow-up</b>. They are prompts for human review — never automatic academic decisions. Set a number to 0 to switch that rule off.</Note>
      <div className="g g3">
        {num('overdue_min', 'Missed deadlines at or above', 0, 20)}
        {num('activity_below', 'Activity score under', 0, 100)}
        {num('inactive_days', 'No activity for at least (days)', 0, 90)}
        {num('avg_below', 'Falling marks with average under (%)', 0, 100)}
        {num('completion_below', 'Completion under (%)', 0, 100)}
      </div>
      <Switch id="st-vfa" checked={v.vf_assisted} onChange={x => setV({ ...v, vf_assisted: x })} label="Flag learners who needed the assisted path in a virtual lesson" />
    </div>}
    <InlineErr msg={err} />
    <div className="row" style={{ marginTop: 14 }}>
      <button className="btn pri" disabled={!dirty || save.isPending} onClick={() => { const e = validate(); if (e) return setErr(e); save.mutate() }}>{save.isPending ? 'Saving…' : 'Save'}</button>
      <button className="btn ghost" disabled={!dirty || save.isPending} onClick={() => { setV({ ...q.data![k] }); setErr(null) }}>Discard changes</button>
      {!dirty && <span className="xs muted">No unsaved changes</span>}
    </div>
  </Card>
}

function Locked({ id, label }: { id: string; label: string }) {
  return <label className="chk" htmlFor={id}><span className="switch"><input id={id} type="checkbox" checked disabled readOnly /><span /></span>{label} <Icon n="lock" size={13} /></label>
}
