import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Icon } from '../../components/Icon'
import { Avatar, Badge, Empty, ErrorBox, Field, Loading, Modal, Note, PageHead, useToast } from '../../components/ui'
import { download, get, patch, post } from '../../lib/api'
import { fmtDate } from '../../lib/format'
import { FOLLOW_KIND, InlineErr, Pager, qs, Sel, useMeta } from './shared'

type Item = { id: string; name: string; student_no: string; programme: string | null; faculty: string | null; reasons: { k: string; t: string; rule: string }[]; action: string; owner_id: string | null; owner_name: string | null; status: string; notes: number; updated_at: string | null; still_flagged: boolean }
type Resp = { items: Item[]; rules: Record<string, any>; statuses: string[]; owners: { id: string; name: string; kind: string }[]; counts: Record<string, number>; by_rule: Record<string, number> }
const RULE_LABEL: Record<string, string> = { deadline: 'Missed deadlines', activity: 'Low activity', inactive: 'Inactive', marks: 'Falling marks', completion: 'Low completion', vf: 'Assisted VF path' }

export default function Risk() {
  const meta = useMeta(); const toast = useToast(); const qc = useQueryClient()
  const [f, setF0] = useState({ faculty: 'all', status: 'open', rule: 'all' })
  const setF = (x: typeof f) => { setF0(x); setPage(1) }
  const q = useQuery({ queryKey: ['admin-risk', f], queryFn: () => get<Resp>('/api/admin/risk' + qs(f)), placeholderData: p => p })
  const [notesFor, setNotesFor] = useState<Item | null>(null)
  const [page, setPage] = useState(1); const PS = 20
  const [saving, setSaving] = useState<string | null>(null)
  const upd = useMutation({ mutationFn: ({ id, body }: { id: string; body: any }) => patch(`/api/admin/risk/${id}`, body),
    onMutate: ({ id }) => setSaving(id), onSettled: () => setSaving(null),
    onSuccess: () => { toast('Saved — recorded in the audit log'); qc.invalidateQueries({ queryKey: ['admin-risk'] }) }, onError: (e: any) => toast(e.message, true) })
  const r = q.data?.rules
  const exportCsv = async () => { try { await download('/api/admin/risk.csv' + qs({ faculty: f.faculty }), 'learners-for-follow-up.csv'); toast('Export downloaded — recorded in the audit log') } catch (e: any) { toast(e.message, true) } }
  return <>
    <PageHead no={25} title="Learners for follow-up" sub="Students meeting a transparent support rule. These are prompts for human review — not predictions, and never automatic academic decisions."
      actions={<button className="btn" onClick={exportCsv}><Icon n="download" />Export</button>} />
    <Note><b>Rules in use:</b> {r ? <>missed deadlines ≥ {r.overdue_min} · activity score under {r.activity_below} · no activity for {r.inactive_days}+ days · falling marks with average under {r.avg_below} · completion under {r.completion_below}%{r.vf_assisted ? ' · assisted path needed in a virtual lesson' : ''}.</> : '…'} Rules are set by the university and can be changed in <Link to="/a-settings">Settings</Link>. Each flag lists the rule that triggered it.</Note>
    <div className="card" style={{ padding: '12px 14px', marginTop: 12 }}><div className="filters">
      <Sel id="rk-fac" label="Faculty / centre" value={f.faculty} onChange={v => setF({ ...f, faculty: v })} options={[['all', 'All faculties & centres'], ...(meta.data?.faculties || []).map(x => [x.id, x.short] as [string, string])]} />
      <Sel id="rk-st" label="Follow-up status" value={f.status} onChange={v => setF({ ...f, status: v })} options={[['open', 'Open (New, Contacted, Support in place)'], ['all', 'All'], ...(q.data?.statuses || []).map(s => [s, s] as [string, string])]} />
      <Sel id="rk-rule" label="Rule" value={f.rule} onChange={v => setF({ ...f, rule: v })} options={[['all', 'Any rule'], ...Object.entries(RULE_LABEL).map(([k, l]) => [k, `${l}${q.data?.by_rule[k] != null ? ` (${q.data.by_rule[k]})` : ''}`] as [string, string])]} />
    </div>{q.data && <div className="chips" style={{ marginTop: 10, gap: 6 }}>{q.data.statuses.map(s => <Badge key={s} kind={FOLLOW_KIND[s]}>{s}: {q.data!.counts[s] || 0}</Badge>)}</div>}</div>
    <div style={{ marginTop: 16 }}>
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} retry={() => q.refetch()} /> : !q.data!.items.length ? <Empty icon="checkc" title="No learners currently flagged">No learner in this view meets a support rule.</Empty> :
        <div className="tbl-wrap" style={{ opacity: q.isFetching ? .6 : 1 }}><table className="t"><thead><tr><th>Student</th><th>Why flagged</th><th className="adm-hide-sm">Suggested support</th><th>Assigned to</th><th>Status</th><th></th></tr></thead>
          <tbody>{q.data!.items.slice((page - 1) * PS, page * PS).map(x => <tr key={x.id}>
            <td><div className="who"><Avatar name={x.name} kind="t" /><div><div className="nm">{x.name}</div><div className="sub">{(x.programme || '').replace(/^(BSc|BEng) \(Hons\) /, '')} · <span className="mono">{x.student_no}</span></div></div></div></td>
            <td style={{ minWidth: 200 }}>{x.reasons.map(rs => <span key={rs.k} className={`b ${rs.k === 'vf' ? 'teal' : 'warn'}`} style={{ margin: 2 }} title={`Rule: ${rs.rule}`}>{rs.t}</span>)}{!x.still_flagged && <span className="b out">No rule met now</span>}</td>
            <td className="small adm-hide-sm" style={{ minWidth: 170 }}>{x.action}<div className="xs muted">Suggestion only — staff decide.</div></td>
            <td><select className="inp" style={{ width: 'auto', maxWidth: 190 }} aria-label={`Assign follow-up for ${x.name}`} value={x.owner_id || ''} disabled={saving === x.id} onChange={e => upd.mutate({ id: x.id, body: { owner_id: e.target.value || null } })}>
              <option value="">Unassigned</option>{q.data!.owners.map(o => <option key={o.id} value={o.id}>{o.name}{o.kind === 'team' ? '' : o.kind === 'admin' ? ' (admin)' : ''}</option>)}</select></td>
            <td><select className="inp" style={{ width: 'auto' }} aria-label={`Status for ${x.name}`} value={x.status} disabled={saving === x.id} onChange={e => upd.mutate({ id: x.id, body: { status: e.target.value } })}>
              {q.data!.statuses.map(s => <option key={s}>{s}</option>)}</select>{x.updated_at && <div className="xs muted">{fmtDate(x.updated_at)}</div>}</td>
            <td><button className="btn sm" onClick={() => setNotesFor(x)}><Icon n="note" />Notes{x.notes ? ` (${x.notes})` : ''}</button></td></tr>)}</tbody></table></div>}
      {q.data && q.data.items.length > PS && <Pager page={page} size={PS} total={q.data.items.length} onPage={setPage} label="learners" />}
    </div>
    <p className="xs muted" style={{ marginTop: 8 }}>Every change to assignment, status or notes is written to the audit log. No automatic academic decision is taken from these indicators.</p>
    {notesFor && <Notes item={notesFor} onClose={() => setNotesFor(null)} />}
  </>
}

function Notes({ item, onClose }: { item: Item; onClose: () => void }) {
  const qc = useQueryClient(); const toast = useToast()
  const q = useQuery({ queryKey: ['admin-risk-notes', item.id], queryFn: () => get<{ text: string; by: string; at: string }[]>(`/api/admin/risk/${item.id}/notes`) })
  const [t, setT] = useState(''); const [err, setErr] = useState<string | null>(null)
  const add = useMutation({ mutationFn: () => post(`/api/admin/risk/${item.id}/notes`, { text: t.trim() }),
    onSuccess: () => { setT(''); toast('Note added'); qc.invalidateQueries({ queryKey: ['admin-risk-notes', item.id] }); qc.invalidateQueries({ queryKey: ['admin-risk'] }) }, onError: (e: any) => setErr(e.message) })
  return <Modal title={`Follow-up notes · ${item.name}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Close</button><button className="btn pri" disabled={add.isPending} onClick={() => { if (t.trim().length < 3) return setErr('Write a note of at least 3 characters.'); setErr(null); add.mutate() }}>{add.isPending ? 'Adding…' : 'Add note'}</button></>}>
    {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} /> : <div className="list">{q.data!.length ? q.data!.map((n, i) => <div className="li" key={i}><div className="bd small">{n.text}<div className="xs muted">{n.by} · {fmtDate(n.at, true)}</div></div></div>) : <p className="small muted">No notes yet.</p>}</div>}
    <Field label="New note" htmlFor="nt" hint="Visible to staff with access only. Keep it factual."><textarea className="inp" id="nt" rows={3} maxLength={1000} value={t} onChange={e => setT(e.target.value)} placeholder="e.g. Emailed to offer a study-plan meeting" /></Field>
    <InlineErr msg={err} />
  </Modal>
}
