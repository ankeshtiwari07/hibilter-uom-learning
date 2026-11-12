/* Webinar emails: date/time update to registrants, weekly newsletter drafts (review → approve → send), company section. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Icon } from '../../components/Icon'
import { Badge, Card, Empty, ErrorBox, Field, Loading, Modal, Note, useToast } from '../../components/ui'
import { get, post, put } from '../../lib/api'
import { fmtDate, rel } from '../../lib/format'
import { InlineErr } from './shared'

type Item = { title: string; url: string; source: string; note: string; include: boolean; published?: string | null }
type Section = { title: string; items: Item[] }
type Company = { name: string; url: string; text: string }
type Camp = { id: string; kind: string; edition: string | null; subject: string; status: string; created_at: string; created_by: string | null; approved_by: string | null; approved_at: string | null; recipients: number; sent: number; queued: number; failed: number; week: string | null; articles: number }
export type MailStatus = { configured: boolean; sender: string | null; owner_notify: string | null; totals: { queued: number; sent: number; failed: number }
  audience: { registered: number; newsletter_mba: number; newsletter_general: number; unsubscribed: number }; update_needed: boolean
  last_update: { at: string | null; event: { when: string } | null }; campaigns: Camp[]; company: Company[]; next_newsletter: string; failed: { to: string; kind: string; error: string; at: string }[] }
type Full = { id: string; kind: string; edition: string | null; subject: string; status: string; html: string; audience: number; label?: string
  content: { headline?: string; intro?: string; outro?: string; sections?: Section[]; company?: Company[]; note?: string; ai?: boolean } }

const ED: Record<string, string> = { mba: 'MBA edition', general: 'General edition' }
const ST: Record<string, [string, string]> = { draft: ['warn', 'Draft — needs your approval'], sending: ['info', 'Sending'], sent: ['good', 'Sent'], discarded: ['out', 'Discarded'] }

export function useMail(wid: string) {
  return useQuery({ queryKey: ['adm-webinar-mail', wid], queryFn: () => get<MailStatus>(`/api/admin/webinars/${wid}/mail`), refetchInterval: 20_000 })
}

export function WebinarEmails({ wid, title, when }: { wid: string; title: string; when: string }) {
  const toast = useToast(); const qc = useQueryClient()
  const m = useMail(wid)
  const [announce, setAnnounce] = useState(false); const [open, setOpen] = useState<string | null>(null); const [comp, setComp] = useState(false)
  const refresh = () => qc.invalidateQueries({ queryKey: ['adm-webinar-mail'] })
  const gen = useMutation({ mutationFn: () => post(`/api/admin/webinars/${wid}/newsletter/generate`), onSuccess: () => { toast('Drafts ready — review them below'); refresh() }, onError: (e: any) => toast(e.message, true) })
  if (m.isLoading) return <Loading />
  if (m.error) return <ErrorBox error={m.error} retry={() => m.refetch()} />
  const d = m.data!
  return <div className="stack">
    {!d.configured && <Note kind="warn" icon="alert"><b>Email sending isn’t connected yet.</b> Once the <span className="mono">events@hibilter.com</span> mailbox is set up on the server, updates and newsletters can be sent. You can already prepare and preview drafts.</Note>}
    {d.update_needed && d.audience.registered > 0 && <div className="note warn" role="alert"><Icon n="cal" /><div style={{ flex: 1 }}><b>Registrants haven’t been told the latest date.</b> The event now shows “{when}”{d.last_update.event ? ` (last update said “${d.last_update.event.when}”)` : ''}. Send it to {d.audience.registered} registered {d.audience.registered === 1 ? 'person' : 'people'}.</div>
      <button className="btn pri sm" onClick={() => setAnnounce(true)}>Send update</button></div>}
    <Card title="Emails" actions={<div className="row" style={{ gap: 6 }}>
      <button className="btn sm" onClick={() => setAnnounce(true)}><Icon n="cal" />Send date update</button>
      <button className="btn sm" disabled={gen.isPending} onClick={() => gen.mutate()}><Icon n="refresh" />{gen.isPending ? 'Collecting articles…' : 'Draft newsletter now'}</button>
      <button className="btn sm ghost" onClick={() => setComp(true)}><Icon n="edit" />Company section</button></div>}>
      <div className="g g4" style={{ marginBottom: 12 }}>
        <div><div className="xs muted">Registered (get event updates)</div><b style={{ fontSize: 20 }}>{d.audience.registered}</b></div>
        <div><div className="xs muted">Newsletter · MBA edition</div><b style={{ fontSize: 20 }}>{d.audience.newsletter_mba}</b></div>
        <div><div className="xs muted">Newsletter · general edition</div><b style={{ fontSize: 20 }}>{d.audience.newsletter_general}</b></div>
        <div><div className="xs muted">Unsubscribed</div><b style={{ fontSize: 20 }}>{d.audience.unsubscribed}</b></div>
      </div>
      <p className="xs muted">Sender: <span className="mono">{d.sender || 'not connected'}</span> · Next newsletter drafts: {fmtDate(d.next_newsletter, true)} (every Monday) — nothing is sent until you approve it. Registrants get a confirmation email automatically when they sign up.{d.totals.queued ? ` ${d.totals.queued} emails waiting to send.` : ''}</p>
      {d.campaigns.length ? <div className="tbl-wrap" style={{ marginTop: 10 }}><table className="t"><thead><tr><th>Email</th><th>Status</th><th className="adm-hide-sm">Delivery</th><th>Created</th></tr></thead>
        <tbody>{d.campaigns.map(c => <tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => setOpen(c.id)}>
          <td><div className="small"><b>{c.kind === 'newsletter' ? `Newsletter · ${ED[c.edition || ''] || ''}` : 'Date & time update'}</b></div><div className="xs muted">{c.subject}</div>{c.kind === 'newsletter' && <div className="xs muted">{c.articles} articles · {c.week}</div>}</td>
          <td><Badge kind={ST[c.status]?.[0]}>{ST[c.status]?.[1] || c.status}</Badge></td>
          <td className="small adm-hide-sm">{c.status === 'draft' ? '—' : <>{c.sent}/{c.recipients} sent{c.queued ? ` · ${c.queued} queued` : ''}{c.failed ? <span style={{ color: 'var(--bad)' }}> · {c.failed} failed</span> : ''}</>}</td>
          <td className="small">{rel(c.created_at)}<div className="xs muted">{c.approved_by ? `sent by ${c.approved_by}` : c.created_by}</div></td></tr>)}</tbody></table></div>
        : <Empty icon="mega" title="No emails yet">The first newsletter drafts appear on Monday, or click “Draft newsletter now”.</Empty>}
      {d.failed.length > 0 && <details style={{ marginTop: 10 }}><summary className="small" style={{ cursor: 'pointer', color: 'var(--bad)' }}>{d.totals.failed} failed deliveries</summary>
        <ul className="xs">{d.failed.map((f, i) => <li key={i}><span className="mono">{f.to}</span> · {f.kind} · {f.error}</li>)}</ul></details>}
    </Card>
    {announce && <AnnounceModal wid={wid} title={title} when={when} configured={d.configured} onClose={() => setAnnounce(false)} onSent={n => { setAnnounce(false); toast(`Update queued for ${n} registrants`); refresh() }} />}
    {open && <CampaignModal wid={wid} cid={open} configured={d.configured} defaultTest={d.owner_notify || ''} onClose={() => setOpen(null)} onChanged={refresh} />}
    {comp && <CompanyModal wid={wid} items={d.company} onClose={() => setComp(false)} onSaved={() => { setComp(false); toast('Company section saved — used in the next drafts'); refresh() }} />}
  </div>
}

function Preview({ html }: { html: string }) {
  return <iframe title="Email preview" srcDoc={html} sandbox="" style={{ width: '100%', height: 460, border: '1px solid var(--line)', borderRadius: 8, background: '#EEF2F6' }} />
}

export function AnnounceModal({ wid, title, when, configured, onClose, onSent }: { wid: string; title: string; when: string; configured: boolean; onClose: () => void; onSent: (n: number) => void }) {
  const [subject, setSubject] = useState(`Confirmed: ${title} — ${when}`); const [note, setNote] = useState(''); const [err, setErr] = useState<string | null>(null); const [sure, setSure] = useState(false)
  const pv = useQuery({ queryKey: ['announce-preview', wid, subject, note], queryFn: () => post<{ recipients: number; html: string }>(`/api/admin/webinars/${wid}/mail/announce`, { subject, note: note || null, dry_run: true }), enabled: subject.trim().length >= 4, placeholderData: p => p })
  const send = useMutation({ mutationFn: () => post<{ recipients: number }>(`/api/admin/webinars/${wid}/mail/announce`, { subject, note: note || null, dry_run: false }), onSuccess: r => onSent(r.recipients), onError: (e: any) => { setErr(e.message); setSure(false) } })
  const n = pv.data?.recipients ?? 0
  return <Modal wide title="Send the date & time to registrants" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button>
    {sure ? <button className="btn pri" disabled={send.isPending} onClick={() => send.mutate()}>{send.isPending ? 'Sending…' : `Yes, email ${n} ${n === 1 ? 'person' : 'people'}`}</button>
      : <button className="btn pri" disabled={!configured || !n} title={!configured ? 'Email isn’t connected yet' : undefined} onClick={() => setSure(true)}><Icon n="send" />Send to {n}</button>}</>}>
    <div className="col">
      <p className="small muted">Uses the event details as they are now (date, place, joining link, calendar). Change those first with “Event details” if needed.</p>
      <Field label="Subject" htmlFor="an-s"><input className="inp" id="an-s" maxLength={200} value={subject} onChange={e => setSubject(e.target.value)} /></Field>
      <Field label="Extra message (optional)" htmlFor="an-n" hint="Blank line = new paragraph"><textarea className="inp" id="an-n" rows={3} maxLength={3000} value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. The session will run for 60 minutes with live Q&A at the end." /></Field>
      {pv.data && <Preview html={pv.data.html} />}
      <InlineErr msg={err} />
    </div>
  </Modal>
}

function CampaignModal({ wid, cid, configured, defaultTest, onClose, onChanged }: { wid: string; cid: string; configured: boolean; defaultTest: string; onClose: () => void; onChanged: () => void }) {
  const toast = useToast(); const qc = useQueryClient()
  const q = useQuery({ queryKey: ['adm-campaign', cid], queryFn: () => get<Full>(`/api/admin/webinars/${wid}/campaigns/${cid}`) })
  const [draft, setDraft] = useState<Full | null>(null); const [tab, setTab] = useState<'edit' | 'preview'>('edit')
  const [testTo, setTestTo] = useState(defaultTest); const [err, setErr] = useState<string | null>(null); const [sure, setSure] = useState(false)
  const f = draft || q.data || null
  const editable = f?.kind === 'newsletter' && f.status === 'draft'
  const set = (fn: (x: Full) => void) => { if (!f) return; const x: Full = JSON.parse(JSON.stringify(f)); fn(x); setDraft(x) }
  const save = useMutation({ mutationFn: () => put<Full>(`/api/admin/webinars/${wid}/campaigns/${cid}`, { subject: f!.subject, content: f!.content }),
    onSuccess: r => { setDraft(null); qc.setQueryData(['adm-campaign', cid], r); onChanged() }, onError: (e: any) => setErr(e.message) })
  const test = useMutation({ mutationFn: async () => { if (draft) await save.mutateAsync(); return post(`/api/admin/webinars/${wid}/campaigns/${cid}/test`, { to: testTo }) }, onSuccess: () => toast(`Test sent to ${testTo}`), onError: (e: any) => setErr(e.message) })
  const send = useMutation({ mutationFn: async () => { if (draft) await save.mutateAsync(); return post<{ recipients: number }>(`/api/admin/webinars/${wid}/campaigns/${cid}/send`) }, onSuccess: r => { toast(`Newsletter queued for ${r.recipients} subscribers`); onChanged(); onClose() }, onError: (e: any) => { setErr(e.message); setSure(false) } })
  const discard = useMutation({ mutationFn: () => post(`/api/admin/webinars/${wid}/campaigns/${cid}/discard`), onSuccess: () => { toast('Draft discarded'); onChanged(); onClose() }, onError: (e: any) => setErr(e.message) })
  const busy = save.isPending || test.isPending || send.isPending || discard.isPending
  return <Modal wide title={f ? (f.kind === 'newsletter' ? `Newsletter · ${f.label || ''}` : 'Date & time update') : 'Email'} onClose={onClose}
    footer={!f ? undefined : editable ? <>
      <button className="btn ghost" disabled={busy} onClick={() => confirm('Discard this draft?') && discard.mutate()}>Discard</button>
      <span style={{ flex: 1 }} />
      {draft && <button className="btn" disabled={busy} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save draft'}</button>}
      {sure ? <button className="btn pri" disabled={busy} onClick={() => send.mutate()}>{send.isPending ? 'Sending…' : `Yes, send to ${f.audience}`}</button>
        : <button className="btn pri" disabled={busy || !configured || !f.audience} title={!configured ? 'Email isn’t connected yet' : !f.audience ? 'Nobody has opted in to this edition yet' : undefined} onClick={() => setSure(true)}><Icon n="send" />Approve & send to {f.audience}</button>}</>
      : <button className="btn" onClick={onClose}>Close</button>}>
    {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : f && <div className="col">
      {editable && <div className="tabs" role="tablist">{(['edit', 'preview'] as const).map(t => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={async () => { if (t === 'preview' && draft) await save.mutateAsync(); setTab(t) }}>{t === 'edit' ? 'Edit' : 'Preview'}</button>)}</div>}
      {editable && tab === 'edit' ? <>
        <Note icon="info">Articles come from Google News (last 7 days) and link to the original publishers. {f.content.ai ? 'Headline, intro and notes were drafted by AI from the headlines — check them.' : 'Add a one-line note on why each story matters, or leave it blank.'} Untick anything you don’t want to send.</Note>
        <Field label="Subject" htmlFor="nl-s"><input className="inp" id="nl-s" maxLength={200} value={f.subject} onChange={e => set(x => { x.subject = e.target.value })} /></Field>
        <Field label="Headline" htmlFor="nl-h"><input className="inp" id="nl-h" maxLength={120} value={f.content.headline || ''} onChange={e => set(x => { x.content.headline = e.target.value })} /></Field>
        <Field label="Intro" htmlFor="nl-i"><textarea className="inp" id="nl-i" rows={3} maxLength={2000} value={f.content.intro || ''} onChange={e => set(x => { x.content.intro = e.target.value })} /></Field>
        {(f.content.sections || []).map((s, si) => <div key={si}><div className="eyebrow" style={{ margin: '8px 0 4px' }}>{s.title}</div>
          {s.items.length ? s.items.map((it, ii) => <div key={it.url} className="li" style={{ alignItems: 'flex-start', gap: 8, opacity: it.include ? 1 : .5 }}>
            <input type="checkbox" aria-label="Include" checked={it.include} onChange={e => set(x => { x.content.sections![si].items[ii].include = e.target.checked })} style={{ marginTop: 4 }} />
            <div className="bd" style={{ flex: 1 }}><a className="small" href={it.url} target="_blank" rel="noopener noreferrer"><b>{it.title}</b></a><div className="xs muted">{it.source}{it.published ? ` · ${fmtDate(it.published)}` : ''}</div>
              <input className="inp" style={{ marginTop: 4 }} maxLength={400} placeholder="Why it matters (optional)" value={it.note} onChange={e => set(x => { x.content.sections![si].items[ii].note = e.target.value })} /></div></div>)
            : <p className="xs muted">No fresh articles found for this section this week.</p>}</div>)}
        <div className="eyebrow" style={{ margin: '8px 0 4px' }}>What we’re building</div>
        {(f.content.company || []).map((c, ci) => <Field key={ci} label={c.name} htmlFor={`nl-c${ci}`}><textarea className="inp" id={`nl-c${ci}`} rows={3} maxLength={1200} value={c.text} onChange={e => set(x => { x.content.company![ci].text = e.target.value })} /></Field>)}
        <Field label="Closing line (optional)" htmlFor="nl-o"><input className="inp" id="nl-o" maxLength={1000} value={f.content.outro || ''} onChange={e => set(x => { x.content.outro = e.target.value })} /></Field>
        <div className="row" style={{ gap: 6, alignItems: 'flex-end' }}><Field label="Send a test to" htmlFor="nl-t"><input className="inp" id="nl-t" type="email" value={testTo} onChange={e => setTestTo(e.target.value)} /></Field>
          <button className="btn" disabled={busy || !configured || !/\S+@\S+\.\S+/.test(testTo)} onClick={() => test.mutate()}>{test.isPending ? 'Sending…' : 'Send test'}</button></div>
      </> : <>{f.kind !== 'newsletter' && <p className="small">{f.subject}</p>}<Preview html={f.html} /></>}
      <InlineErr msg={err} />
    </div>}
  </Modal>
}

function CompanyModal({ wid, items, onClose, onSaved }: { wid: string; items: Company[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<Company[]>(items.length ? items : [{ name: 'Hibilter IT Systems', url: 'https://www.hibilter.com', text: '' }, { name: 'TuQuant', url: 'https://tuquant.si', text: '' }])
  const [err, setErr] = useState<string | null>(null)
  const m = useMutation({ mutationFn: () => put(`/api/admin/webinars/${wid}/newsletter/company`, { items: f }), onSuccess: onSaved, onError: (e: any) => setErr(e.message) })
  return <Modal title="“What we’re building” section" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn pri" disabled={m.isPending} onClick={() => m.mutate()}>{m.isPending ? 'Saving…' : 'Save'}</button></>}>
    <div className="col">
      <p className="small muted">Goes at the end of every newsletter. Keep it to what you’re happy to say publicly — current BFSI and enterprise work, launches, wins. You can still edit it per edition before sending.</p>
      {f.map((c, i) => <div key={i} className="col" style={{ gap: 6 }}>
        <div className="g g2"><Field label="Company" htmlFor={`co-n${i}`}><input className="inp" id={`co-n${i}`} maxLength={80} value={c.name} onChange={e => setF(f.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} /></Field>
          <Field label="Link" htmlFor={`co-u${i}`}><input className="inp" id={`co-u${i}`} maxLength={200} value={c.url} onChange={e => setF(f.map((x, j) => j === i ? { ...x, url: e.target.value } : x))} /></Field></div>
        <Field label="What they’re working on" htmlFor={`co-t${i}`}><textarea className="inp" id={`co-t${i}`} rows={4} maxLength={1200} value={c.text} onChange={e => setF(f.map((x, j) => j === i ? { ...x, text: e.target.value } : x))} /></Field></div>)}
      <InlineErr msg={err} />
    </div>
  </Modal>
}
