import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Icon } from '../../components/Icon'
import { Card, Empty, ErrorBox, Field, Loading, Modal, PageHead, useToast } from '../../components/ui'
import { del, download, get, post } from '../../lib/api'
import { InlineErr, qs, Sel, useMeta } from './shared'

type Catalogue = { reports: { id: string; title: string; desc: string; definition: string }[]; presets: { id: string; name: string; report: string; faculty: string; from?: string | null; to?: string | null; relative_days?: number | null; created_by: string }[]; default_period: { from: string; to: string } }
type Preview = { id: string; title: string; definition: string; columns: string[]; rows: (string | number | null)[][]; generated_at: string; period: { from: string; to: string }; scope: string }

const iso = (d: Date) => d.toISOString().slice(0, 10)

export default function Reports() {
  const meta = useMeta(); const toast = useToast(); const qc = useQueryClient()
  const cat = useQuery({ queryKey: ['admin-reports'], queryFn: () => get<Catalogue>('/api/admin/reports') })
  const [rep, setRep] = useState('comp')
  const [fac, setFac] = useState('all')
  const [from, setFrom] = useState(''); const [to, setTo] = useState('')
  const [saveOpen, setSaveOpen] = useState(false)
  const pf = from || cat.data?.default_period.from || '', pt = to || cat.data?.default_period.to || ''
  const bad = pf && pt && pf > pt ? 'The start date is after the end date.' : null
  const params = { faculty: fac, from: pf, to: pt }
  const prev = useQuery({ queryKey: ['admin-report', rep, params], enabled: !!cat.data && !bad, queryFn: () => get<Preview>(`/api/admin/reports/${rep}` + qs(params)) })
  const [exporting, setExporting] = useState(false)
  const exportCsv = async () => {
    if (bad) return
    setExporting(true)
    try { await download(`/api/admin/reports/${rep}/csv` + qs(params), `${rep}-report-${pf}-to-${pt}.csv`); toast('Report exported — recorded in the audit log') }
    catch (e: any) { toast(e.message, true) } finally { setExporting(false) }
  }
  const rmPreset = useMutation({ mutationFn: (id: string) => del(`/api/admin/report-presets/${id}`), onSuccess: () => { toast('Saved report deleted'); qc.invalidateQueries({ queryKey: ['admin-reports'] }) }, onError: (e: any) => toast(e.message, true) })
  const applyPreset = (p: Catalogue['presets'][0]) => {
    setRep(p.report); setFac(p.faculty || 'all')
    if (p.relative_days) { const t = new Date(); setTo(iso(t)); setFrom(iso(new Date(t.getTime() - p.relative_days * 864e5))) }
    else { setFrom(p.from || ''); setTo(p.to || '') }
    toast(`Loaded “${p.name}”`)
  }
  if (cat.isLoading) return <><PageHead no={26} title="Reporting centre" /><Loading /></>
  if (cat.error) return <><PageHead no={26} title="Reporting centre" /><ErrorBox error={cat.error} retry={() => cat.refetch()} /></>
  const c = cat.data!
  return <>
    <PageHead no={26} title="Reporting centre" sub="Generate, preview and export standard reports with consistent metric definitions." />
    <div className="g g-12">
      <div className="stack">
        <Card title="Reports"><div className="list">{c.reports.map(r => <button key={r.id} className="li" onClick={() => setRep(r.id)} aria-pressed={r.id === rep}
          style={{ border: 0, background: r.id === rep ? 'var(--teal-soft)' : 'transparent', textAlign: 'left', cursor: 'pointer', borderRadius: 8, padding: 10, font: 'inherit', color: 'inherit' }}>
          <div className="ic"><Icon n={r.id === 'vf' ? 'cap' : 'csv'} /></div><div className="bd"><div className="tt">{r.title}</div><div className="ds">{r.desc}</div></div></button>)}</div></Card>
        <Card title="Saved reports" actions={<button className="btn sm" onClick={() => setSaveOpen(true)}><Icon n="save" />Save current</button>}>
          {c.presets.length ? <div className="list">{c.presets.map(p => <div className="li" key={p.id}><div className="ic"><Icon n="bookmark" /></div>
            <div className="bd"><button className="link-btn tt" onClick={() => applyPreset(p)}>{p.name}</button><div className="ds">{c.reports.find(r => r.id === p.report)?.title} · {p.relative_days ? `last ${p.relative_days} days` : `${p.from || '…'} to ${p.to || '…'}`} · by {p.created_by}</div></div>
            <button className="btn sm ghost" aria-label={`Delete ${p.name}`} disabled={rmPreset.isPending} onClick={() => rmPreset.mutate(p.id)}><Icon n="x" /></button></div>)}</div>
            : <p className="small muted">No saved reports yet. Choose a report and filters, then “Save current”.</p>}
        </Card>
      </div>
      <div className="stack">
        <div className="card" style={{ padding: '12px 14px' }}><div className="filters">
          <Sel id="rp-fac" label="Faculty" value={fac} onChange={setFac} options={[['all', 'All'], ...(meta.data?.faculties || []).map(f => [f.id, f.short] as [string, string])]} />
          <Field label="From" htmlFor="rp-from"><input className={`inp ${bad ? 'bad' : ''}`} type="date" id="rp-from" value={pf} onChange={e => setFrom(e.target.value)} /></Field>
          <Field label="To" htmlFor="rp-to"><input className={`inp ${bad ? 'bad' : ''}`} type="date" id="rp-to" value={pt} onChange={e => setTo(e.target.value)} /></Field>
          <span className="sp" /><button className="btn pri" disabled={!!bad || exporting} onClick={exportCsv}><Icon n="download" />{exporting ? 'Exporting…' : 'Export CSV'}</button>
        </div><InlineErr msg={bad} /></div>
        <div className="card">
          {bad ? <Empty icon="alert" title="Fix the date range">{bad}</Empty> : prev.isLoading ? <Loading label="Generating report…" /> : prev.error ? <ErrorBox error={prev.error} retry={() => prev.refetch()} /> : prev.data && <>
            <div className="row sb" style={{ borderBottom: '2px solid var(--navy)', paddingBottom: 10, marginBottom: 12 }}><div><div className="eyebrow">University of Mauritius · UoM Learning</div><h2>{prev.data.title}</h2></div></div>
            <dl className="kv"><dt>Generated</dt><dd>{new Date(prev.data.generated_at).toLocaleString('en-GB')}</dd><dt>Reporting period</dt><dd>{prev.data.period.from} to {prev.data.period.to}</dd><dt>Scope</dt><dd>{prev.data.scope}</dd><dt>Definition</dt><dd className="small">{prev.data.definition}</dd></dl>
            {prev.data.rows.length ? <div className="tbl-wrap" style={{ marginTop: 12, maxHeight: 520, overflowY: 'auto' }}><table className="t"><thead><tr>{prev.data.columns.map(h => <th key={h}>{h}</th>)}</tr></thead>
              <tbody>{prev.data.rows.slice(0, 200).map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} className={typeof v === 'number' ? 'n' : 'small'}>{v ?? '—'}</td>)}</tr>)}</tbody></table></div>
              : <Empty icon="csv" title="No rows for this period and scope">Try a wider date range or another faculty.</Empty>}
            {prev.data.rows.length > 200 && <p className="xs muted">Showing the first 200 of {prev.data.rows.length} rows. The CSV export contains all rows.</p>}
            <p className="xs muted" style={{ marginTop: 8 }}>Synthetic data for demonstration. Not official University of Mauritius figures. Exports include the period, generation time and definitions.</p>
          </>}
        </div>
      </div>
    </div>
    {saveOpen && <SavePreset report={rep} faculty={fac} from={pf} to={pt} onClose={() => setSaveOpen(false)} onDone={() => { setSaveOpen(false); toast('Report saved'); qc.invalidateQueries({ queryKey: ['admin-reports'] }) }} />}
  </>
}

function SavePreset({ report, faculty, from, to, onClose, onDone }: { report: string; faculty: string; from: string; to: string; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(''); const [mode, setMode] = useState('fixed'); const [days, setDays] = useState(30)
  const [err, setErr] = useState<string | null>(null)
  const m = useMutation({ mutationFn: () => post('/api/admin/report-presets', { name: name.trim(), report, faculty, ...(mode === 'fixed' ? { from, to } : { relative_days: days }) }), onSuccess: onDone, onError: (e: any) => setErr(e.message) })
  return <Modal title="Save report" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn pri" disabled={m.isPending} onClick={() => { if (name.trim().length < 3) return setErr('Name the saved report (at least 3 characters).'); if (mode === 'rel' && (days < 1 || days > 1100)) return setErr('Choose between 1 and 1100 days.'); setErr(null); m.mutate() }}>{m.isPending ? 'Saving…' : 'Save'}</button></>}>
    <div className="col">
      <Field label="Name" htmlFor="ps-n"><input className="inp" id="ps-n" value={name} maxLength={80} onChange={e => setName(e.target.value)} placeholder="e.g. ICDT completion — monthly" /></Field>
      <Sel id="ps-m" label="Period" value={mode} onChange={setMode} options={[['fixed', `Fixed: ${from} to ${to}`], ['rel', 'Rolling: last N days']]} />
      {mode === 'rel' && <Field label="Days" htmlFor="ps-d"><input className="inp" id="ps-d" type="number" min={1} max={1100} value={days} onChange={e => setDays(Number(e.target.value))} /></Field>}
      <InlineErr msg={err} />
    </div></Modal>
}
