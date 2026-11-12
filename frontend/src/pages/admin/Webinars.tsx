/* Administrator: webinar registrations portal — share links, live figures, registrations, event settings, CSV. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Icon } from '../../components/Icon'
import { Badge, Card, Empty, ErrorBox, Field, HBars, Kpi, Loading, Modal, PageHead, useToast, VBars } from '../../components/ui'
import { download, get, patch } from '../../lib/api'
import { fmtDate, rel } from '../../lib/format'
import { InlineErr, Pager, qs, Sel, useDebounced } from './shared'
import { AnnounceModal, useMail, WebinarEmails } from './WebinarEmails'

const WID = 'ai-quantum-2026'
type W = { id: string; title: string; presenters: string; summary: string; when: string; starts_at: string | null; duration_min: number; where: string; status: string; capacity: number | null; join_url: string | null; open: boolean }
type Row = { label: string; value: number }
type Detail = { webinar: W; kpis: { total: number; today: number; week: number; cancelled: number; attended: number; questions: number; capacity: number | null }; by_programme: Row[]; by_role: Row[]; by_source: Row[]; by_institution: Row[]; daily: { date: string; value: number }[]; filters: { programmes: string[]; sources: string[] } }
type Reg = { id: string; ref: string; name: string; email: string; phone: string | null; role: string; institution: string; programme: string | null; year_of_study: string | null; city: string | null; question: string | null; source: string; consent_updates: boolean; status: string; notes: string | null; created_at: string; updated_at: string | null }
const ROLE: Record<string, string> = { student: 'Student', faculty: 'Faculty', professional: 'Professional', other: 'Other' }
const ST: Record<string, string> = { registered: 'info', attended: 'good', cancelled: 'out' }

export default function Webinars() {
  const toast = useToast(); const qc = useQueryClient()
  const d = useQuery({ queryKey: ['adm-webinar', WID], queryFn: () => get<Detail>(`/api/admin/webinars/${WID}`), refetchInterval: 30_000 })
  const [q, setQ] = useState(''); const dq = useDebounced(q)
  const [f, setF] = useState({ status: 'all', role: 'all', programme: 'all', source: 'all' }); const [page, setPage] = useState(1)
  const params = { q: dq, ...f }
  const list = useQuery({ queryKey: ['adm-webinar-regs', WID, params, page], queryFn: () => get<{ items: Reg[]; total: number }>(`/api/admin/webinars/${WID}/registrations` + qs({ ...params, page, size: 25 })), placeholderData: p => p, refetchInterval: 30_000 })
  const [open, setOpen] = useState<Reg | null>(null); const [edit, setEdit] = useState(false); const [busyCsv, setBusyCsv] = useState(false)
  const mailQ = useMail(WID); const [tell, setTell] = useState<string | null>(null)
  const refresh = () => { qc.invalidateQueries({ queryKey: ['adm-webinar'] }); qc.invalidateQueries({ queryKey: ['adm-webinar-regs'] }) }
  const setFl = (k: string, v: string) => { setF({ ...f, [k]: v }); setPage(1) }
  const exportCsv = async () => { setBusyCsv(true); try { await download(`/api/admin/webinars/${WID}/registrations.csv` + qs(params), `webinar-registrations-${new Date().toISOString().slice(0, 10)}.csv`); toast('Export downloaded') } catch (e: any) { toast(e.message, true) } finally { setBusyCsv(false) } }
  const w = d.data?.webinar, k = d.data?.kpis
  return <>
    <PageHead title="Webinar registrations" sub={w ? `${w.title} · ${w.presenters}` : 'Public registrations for the live webinar.'}
      actions={<><button className="btn" onClick={() => setEdit(true)} disabled={!w}><Icon n="cog" />Event details</button><button className="btn pri" onClick={exportCsv} disabled={busyCsv}><Icon n="csv" />{busyCsv ? 'Exporting…' : 'Export CSV'}</button></>} />
    {d.isLoading ? <Loading /> : d.error ? <ErrorBox error={d.error} retry={() => d.refetch()} /> : <div className="stack">
      <ShareLinks w={w!} />
      <WebinarEmails wid={WID} title={w!.title} when={w!.when} />
      <div className="g g6">
        <Kpi label="Registered" value={k!.total.toLocaleString()} delta={k!.capacity ? `of ${k!.capacity} seats` : 'no seat limit'} />
        <Kpi label="Today" value={k!.today} delta="since midnight UTC" />
        <Kpi label="Last 7 days" value={k!.week} />
        <Kpi label="Questions asked" value={k!.questions} delta="for the speakers" />
        <Kpi label="Attended" value={k!.attended} delta="marked after the event" />
        <Kpi label="Cancelled" value={k!.cancelled} />
      </div>
      <div className="g g-21">
        <Card title="Registrations per day" actions={<span className="xs muted">last 14 days</span>}>
          {k!.total ? <VBars data={d.data!.daily.slice(-14).map(x => ({ label: fmtDate(x.date).replace(/ \w+$/, ''), value: x.value }))} color="#7C5CFF" /> : <Empty icon="chart" title="No registrations yet">Share the link to start collecting registrations.</Empty>}
        </Card>
        <Card title="Where they came from">{d.data!.by_source.length ? <HBars rows={d.data!.by_source} /> : <p className="small muted">—</p>}</Card>
      </div>
      <div className="g g3">
        <Card title="Programme / track">{d.data!.by_programme.length ? <HBars rows={d.data!.by_programme} /> : <p className="small muted">—</p>}</Card>
        <Card title="Who they are">{d.data!.by_role.length ? <HBars rows={d.data!.by_role} /> : <p className="small muted">—</p>}</Card>
        <Card title="Top institutions">{d.data!.by_institution.length ? <HBars rows={d.data!.by_institution} /> : <p className="small muted">—</p>}</Card>
      </div>
      <div className="card" style={{ padding: '12px 14px' }}><div className="filters">
        <div className="field" style={{ flex: '1 1 220px' }}><label htmlFor="wr-q">Search</label><input className="inp" id="wr-q" type="search" placeholder="Name, email, phone, institution or code" maxLength={100} value={q} onChange={e => { setQ(e.target.value); setPage(1) }} /></div>
        <Sel id="wr-s" label="Status" value={f.status} onChange={v => setFl('status', v)} options={[['all', 'All'], ['registered', 'Registered'], ['attended', 'Attended'], ['cancelled', 'Cancelled']]} />
        <Sel id="wr-r" label="I am" value={f.role} onChange={v => setFl('role', v)} options={[['all', 'All'], ...Object.entries(ROLE)]} />
        <Sel id="wr-p" label="Programme" value={f.programme} onChange={v => setFl('programme', v)} options={[['all', 'All'], ...d.data!.filters.programmes.filter(p => p !== '—').map(p => [p, p] as [string, string]), ['_none', 'Not given']]} />
        <Sel id="wr-src" label="Source" value={f.source} onChange={v => setFl('source', v)} options={[['all', 'All'], ...d.data!.filters.sources.map(p => [p, p] as [string, string])]} />
      </div></div>
      {list.isLoading ? <Loading /> : list.error ? <ErrorBox error={list.error} retry={() => list.refetch()} /> : <>
        <div className="tbl-wrap" style={{ opacity: list.isFetching ? .7 : 1 }}><table className="t"><thead><tr><th>Registrant</th><th>I am / institution</th><th className="adm-hide-sm">Programme</th><th className="adm-hide-sm">Source</th><th>Registered</th><th>Status</th></tr></thead>
          <tbody>{list.data!.items.map(r => <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => setOpen(r)}>
            <td><div className="nm small"><b>{r.name}</b>{r.question && <> <span title="Asked a question"><Icon n="msg" size={13} /></span></>}</div><div className="sub xs">{r.email}{r.phone ? ` · ${r.phone}` : ''}</div><div className="xs muted mono">{r.ref}</div></td>
            <td className="small">{ROLE[r.role] || r.role}<div className="xs muted">{r.institution}</div></td>
            <td className="small adm-hide-sm">{r.programme || '—'}{r.year_of_study && <div className="xs muted">{r.year_of_study}</div>}</td>
            <td className="small adm-hide-sm"><Badge kind="out">{r.source}</Badge></td>
            <td className="small" title={new Date(r.created_at).toLocaleString()}>{rel(r.created_at)}</td>
            <td><Badge kind={ST[r.status]}>{r.status}</Badge></td></tr>)}
            {!list.data!.items.length && <tr><td colSpan={6}><Empty icon="users" title={k!.total ? 'No registrations match' : 'No registrations yet'}>{k!.total ? 'Try a different search or clear the filters.' : 'They will appear here the moment someone registers.'}</Empty></td></tr>}</tbody></table></div>
        <Pager page={page} size={25} total={list.data!.total} onPage={setPage} label="registrations" />
      </>}
    </div>}
    {open && <RegModal r={open} onClose={() => setOpen(null)} onSaved={() => { setOpen(null); refresh(); toast('Registration updated') }} />}
    {edit && w && <EditModal w={w} onClose={() => setEdit(false)} onSaved={(nw: W) => { setEdit(false); refresh(); qc.invalidateQueries({ queryKey: ['adm-webinar-mail'] }); toast('Event details saved — the public page shows them now')
      if ((nw.when !== w.when || nw.starts_at !== w.starts_at || nw.join_url !== w.join_url) && k!.total > 0) setTell(nw.when) }} />}
    {tell && <AnnounceModal wid={WID} title={w!.title} when={tell} configured={!!mailQ.data?.configured} onClose={() => setTell(null)} onSent={n => { setTell(null); toast(`Update queued for ${n} registrants`); qc.invalidateQueries({ queryKey: ['adm-webinar-mail'] }) }} />}
  </>
}

function ShareLinks({ w }: { w: W }) {
  const toast = useToast(); const base = `${location.origin}/webinar`
  const links: [string, string][] = [['General invitation', base], ['MBA students', `${base}/mba`], ['WhatsApp campaign', `${base}?src=whatsapp`], ['LinkedIn post', `${base}?src=linkedin`]]
  return <Card title={<>Registration links {w.open ? <Badge kind="good" dot>Open</Badge> : <Badge kind="bad" dot>Closed</Badge>}</>} actions={<a className="btn sm" href="/webinar" target="_blank" rel="noopener noreferrer"><Icon n="eye" />Open public page</a>}>
    <div className="list">{links.map(([l, u]) => <div className="li" key={u}><div className="bd"><b className="small">{l}</b><div className="xs mono muted" style={{ wordBreak: 'break-all' }}>{u}</div></div>
      <button className="btn sm" onClick={() => navigator.clipboard?.writeText(u).then(() => toast('Link copied'))}><Icon n="file" />Copy</button></div>)}</div>
    <p className="xs muted" style={{ marginTop: 8 }}>Add <span className="mono">?src=&lt;channel&gt;</span> to any link to see where registrations come from, and <span className="mono">&amp;name=&lt;first name&gt;</span> to greet someone personally.</p>
  </Card>
}

function RegModal({ r, onClose, onSaved }: { r: Reg; onClose: () => void; onSaved: () => void }) {
  const [status, setStatus] = useState(r.status); const [notes, setNotes] = useState(r.notes || ''); const [err, setErr] = useState<string | null>(null)
  const m = useMutation({ mutationFn: () => patch(`/api/admin/webinars/${WID}/registrations/${r.id}`, { status, notes }), onSuccess: onSaved, onError: (e: any) => setErr(e.message) })
  return <Modal title={r.name} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Close</button><button className="btn pri" disabled={m.isPending} onClick={() => m.mutate()}>{m.isPending ? 'Saving…' : 'Save'}</button></>}>
    <dl className="kv">
      <dt>Code</dt><dd className="mono">{r.ref}</dd>
      <dt>Email</dt><dd><a href={`mailto:${r.email}`}>{r.email}</a></dd>
      <dt>WhatsApp</dt><dd>{r.phone ? <a href={`https://wa.me/${r.phone.replace(/[^0-9]/g, '')}`} target="_blank" rel="noopener noreferrer">{r.phone}</a> : '—'}</dd>
      <dt>I am</dt><dd>{ROLE[r.role] || r.role}</dd>
      <dt>Institution</dt><dd>{r.institution}</dd>
      <dt>Programme</dt><dd>{r.programme || '—'}{r.year_of_study ? ` · ${r.year_of_study}` : ''}</dd>
      <dt>City</dt><dd>{r.city || '—'}</dd>
      <dt>Source</dt><dd>{r.source}</dd>
      <dt>Future events</dt><dd>{r.consent_updates ? 'Yes, opted in' : 'No'}</dd>
      <dt>Registered</dt><dd>{new Date(r.created_at).toLocaleString()}{r.updated_at ? ` · updated ${rel(r.updated_at)}` : ''}</dd>
    </dl>
    {r.question && <div className="note" style={{ marginTop: 10 }}><Icon n="msg" /><div><b>Question for the speakers</b><div>{r.question}</div></div></div>}
    <div className="col" style={{ marginTop: 12 }}>
      <Sel id="rg-s" label="Status" value={status} onChange={setStatus} options={[['registered', 'Registered'], ['attended', 'Attended'], ['cancelled', 'Cancelled']]} />
      <Field label="Internal notes" htmlFor="rg-n"><textarea className="inp" id="rg-n" rows={3} maxLength={2000} value={notes} onChange={e => setNotes(e.target.value)} /></Field>
      <InlineErr msg={err} />
    </div>
  </Modal>
}

function toLocalInput(iso: string | null) {
  if (!iso) return ''
  const d = new Date(iso); const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

function EditModal({ w, onClose, onSaved }: { w: W; onClose: () => void; onSaved: (nw: W) => void }) {
  const [f, setF] = useState({ when_text: w.when, starts_at: toLocalInput(w.starts_at), duration_min: String(w.duration_min || 60), where_text: w.where, join_url: w.join_url || '', status: w.status, capacity: w.capacity ? String(w.capacity) : '' })
  const [err, setErr] = useState<string | null>(null)
  const m = useMutation({
    mutationFn: () => patch(`/api/admin/webinars/${WID}`, { when_text: f.when_text.trim(), where_text: f.where_text.trim(), join_url: f.join_url.trim() || null, status: f.status,
      capacity: f.capacity ? Number(f.capacity) : 0, duration_min: Number(f.duration_min) || 60,
      ...(f.starts_at ? { starts_at: new Date(f.starts_at).toISOString() } : { clear_starts_at: true }) }),
    onSuccess: (r: any) => onSaved(r as W), onError: (e: any) => setErr(e.message) })
  return <Modal title="Event details" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn pri" disabled={m.isPending} onClick={() => m.mutate()}>{m.isPending ? 'Saving…' : 'Save'}</button></>}>
    <div className="col">
      <Field label="Date & time as shown on the page" htmlFor="ev-w" hint="e.g. Saturday 28 November 2026 · 4:00 PM (MUT)"><input className="inp" id="ev-w" maxLength={120} value={f.when_text} onChange={e => setF({ ...f, when_text: e.target.value })} /></Field>
      <div className="g g2">
        <Field label="Start (your local time)" htmlFor="ev-s" hint="Enables “Add to calendar” for registrants"><input className="inp" id="ev-s" type="datetime-local" value={f.starts_at} onChange={e => setF({ ...f, starts_at: e.target.value })} /></Field>
        <Field label="Length (minutes)" htmlFor="ev-d"><input className="inp" id="ev-d" type="number" min={15} max={600} value={f.duration_min} onChange={e => setF({ ...f, duration_min: e.target.value })} /></Field>
      </div>
      <Field label="Where" htmlFor="ev-p"><input className="inp" id="ev-p" maxLength={120} value={f.where_text} onChange={e => setF({ ...f, where_text: e.target.value })} /></Field>
      <Field label="Joining link (private — not shown on the public page)" htmlFor="ev-j"><input className="inp" id="ev-j" type="url" placeholder="https://…" maxLength={500} value={f.join_url} onChange={e => setF({ ...f, join_url: e.target.value })} /></Field>
      <div className="g g2">
        <Sel id="ev-st" label="Registration" value={f.status} onChange={v => setF({ ...f, status: v })} options={[['open', 'Open'], ['closed', 'Closed']]} />
        <Field label="Seat limit" htmlFor="ev-c" hint="Leave empty for no limit"><input className="inp" id="ev-c" type="number" min={0} value={f.capacity} onChange={e => setF({ ...f, capacity: e.target.value })} /></Field>
      </div>
      <InlineErr msg={err} />
    </div>
  </Modal>
}
