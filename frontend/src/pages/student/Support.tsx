import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Icon } from '../../components/Icon'
import { AiTag, Badge, Card, Empty, ErrorBox, Field, Loading, PageHead, useToast } from '../../components/ui'
import { get, post } from '../../lib/api'
import { fmtDate, rel } from '../../lib/format'
import { CourseCard, errText } from './shared'

type Faq = { id: number; q: string; a: string; category: string }
type Ticket = { id: string; category: string; subject: string; body: string; status: string; at: string; updates: { at?: string; text?: string }[] }
const CATS = ['Academic', 'Technical', 'Accessibility', 'Wellbeing', 'Fees & administration', 'Enrolment']
const STATUS: Record<string, [string, string]> = { open: ['info', 'Received'], 'in progress': ['warn', 'In progress'], resolved: ['good', 'Resolved'], closed: ['out', 'Closed'] }

function useDebounced<T>(v: T, ms = 250) { const [d, setD] = useState(v); useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t) }, [v, ms]); return d }

export default function Support() {
  const [sp] = useSearchParams()
  const topic = sp.get('topic') || ''
  const [fq, setFq] = useState('')
  const dq = useDebounced(fq)
  const faq = useQuery({ queryKey: ['s-faq', dq], queryFn: () => get<Faq[]>(`/api/student/support/faq?q=${encodeURIComponent(dq)}`) })
  const tickets = useQuery({ queryKey: ['s-tickets'], queryFn: () => get<Ticket[]>('/api/student/support/tickets') })
  const courses = useQuery({ queryKey: ['s-courses'], queryFn: () => get<CourseCard[]>('/api/student/courses') })
  const formRef = useRef<HTMLDivElement>(null)
  const [prefill, setPrefill] = useState<{ category: string; subject: string; course?: string; n: number } | null>(null)
  useEffect(() => {
    if (!topic || !courses.data) return
    const code = topic.split(/\s+/)[0]
    const c = courses.data.find(x => x.code.toLowerCase() === code.toLowerCase())
    setPrefill({ category: 'Academic', subject: `Question about ${topic}`.slice(0, 200), course: c?.id, n: Date.now() })
    setTimeout(() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
  }, [topic, courses.data])
  const human = () => { setPrefill({ category: 'Academic', subject: 'Request to speak to an advisor', n: Date.now() }); formRef.current?.scrollIntoView({ behavior: 'smooth' }) }
  return <>
    <PageHead no={12} title="Student support" sub="Find answers, ask the support assistant, or raise a request with a person." />
    <div className="g g-21"><div className="stack">
      <Card title="Frequently asked questions">
        <input className="inp" placeholder="Search FAQs…" aria-label="Search FAQs" value={fq} onChange={e => setFq(e.target.value)} />
        <div className="col" style={{ marginTop: 10 }}>{faq.isLoading ? <Loading /> : faq.error ? <ErrorBox error={faq.error} retry={() => faq.refetch()} /> : faq.data!.length
          ? faq.data!.map(f => <details className="spec" key={f.id}><summary><b>{f.q}</b><Badge kind="out">{f.category}</Badge></summary><div style={{ padding: '12px 16px' }} className="small">{f.a}</div></details>)
          : <Empty icon="search" title="No FAQ matches">Ask the support assistant or raise a request.</Empty>}</div>
      </Card>
      <div ref={formRef}><TicketForm courses={courses.data || []} prefill={prefill} /></div>
    </div>
      <div className="stack">
        <SupportChat onHuman={human} />
        <Card title="My requests">{tickets.isLoading ? <Loading /> : tickets.error ? <ErrorBox error={tickets.error} retry={() => tickets.refetch()} /> : tickets.data!.length
          ? <div className="list">{tickets.data!.map(t => { const [k, l] = STATUS[t.status] || ['out', t.status]; const last = t.updates[t.updates.length - 1]
            return <details className="li" key={t.id} style={{ display: 'block' }}><summary style={{ display: 'flex', gap: 12, cursor: 'pointer', listStyle: 'none' }}><div className="ic"><Icon n="clip" /></div>
              <div className="bd"><div className="tt">{t.subject}</div><div className="ds">{t.id} · {t.category} · {fmtDate(t.at)}</div>{last?.text && <div className="xs muted">{last.text}</div>}</div><Badge kind={k}>{l}</Badge></summary>
              <div className="small" style={{ padding: '8px 0 0 46px' }}><p style={{ whiteSpace: 'pre-wrap' }}>{t.body}</p>
                {t.updates.length > 0 && <div className="tl" style={{ marginTop: 8 }}>{t.updates.map((u, i) => <div className="it n" key={i}><span className="small">{u.text}</span><div className="xs muted">{u.at && !isNaN(Date.parse(u.at)) ? rel(u.at) : u.at}</div></div>)}</div>}</div></details> })}</div>
          : <Empty icon="clip" title="No requests yet" />}</Card>
        <Card title="Contacts" actions={<span className="demo-tag">Placeholder contacts</span>}><dl className="kv small"><dt>IT helpdesk</dt><dd>helpdesk@demo.uom.example</dd><dt>Student welfare</dt><dd>welfare@demo.uom.example</dd><dt>Special needs</dt><dd>access@demo.uom.example</dd><dt>Academic office</dt><dd>academic@demo.uom.example</dd></dl>
          <p className="xs muted" style={{ marginTop: 6 }}>Production would link to the university’s official Student Welfare Office and Special Needs Students pages.</p></Card>
      </div></div>
  </>
}

function TicketForm({ courses, prefill }: { courses: CourseCard[]; prefill: { category: string; subject: string; course?: string; n: number } | null }) {
  const qc = useQueryClient(); const toast = useToast()
  const blank = { category: '', course_id: '', subject: '', body: '' }
  const [f, setF] = useState(blank)
  const [errs, setErrs] = useState<Record<string, string>>({})
  useEffect(() => { if (prefill) { setF(x => ({ ...x, category: prefill.category, subject: prefill.subject, course_id: prefill.course || x.course_id })); setErrs({}) } }, [prefill])
  const m = useMutation({
    mutationFn: () => post<{ id: string; routed_to: string }>('/api/student/support/tickets', { category: f.category, subject: f.subject.trim(), body: f.body.trim(), course_id: f.course_id || null }),
    onSuccess: r => { toast(`Request ${r.id} submitted — routed to ${r.routed_to}`); setF(blank); qc.invalidateQueries({ queryKey: ['s-tickets'] }) },
    onError: (e: any) => toast(errText(e), true),
  })
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const x: Record<string, string> = {}
    if (!f.category) x.category = 'Choose a category.'
    if (f.subject.trim().length < 3) x.subject = 'Add a subject.'
    if (f.body.trim().length < 20) x.body = `Describe your request in at least 20 characters (${f.body.trim().length}/20).`
    setErrs(x); if (!Object.keys(x).length) m.mutate()
  }
  return <Card title="Raise a support request"><form className="g g2" noValidate onSubmit={submit}>
    <Field label="Category" htmlFor="sr-cat" error={errs.category}><select className="inp" id="sr-cat" value={f.category} onChange={e => setF({ ...f, category: e.target.value })}><option value="">Choose…</option>{CATS.map(c => <option key={c}>{c}</option>)}</select></Field>
    <Field label="Related course (optional)" htmlFor="sr-course"><select className="inp" id="sr-course" value={f.course_id} onChange={e => setF({ ...f, course_id: e.target.value })}><option value="">None</option>{courses.map(c => <option key={c.id} value={c.id}>{c.code}</option>)}</select></Field>
    <div style={{ gridColumn: '1/-1' }}><Field label="Subject" htmlFor="sr-t" error={errs.subject}><input className="inp" id="sr-t" maxLength={200} value={f.subject} onChange={e => setF({ ...f, subject: e.target.value })} /></Field></div>
    <div style={{ gridColumn: '1/-1' }}><Field label="Describe what you need" htmlFor="sr-d" error={errs.body} hint="At least 20 characters. Don’t include passwords.">
      <textarea className="inp" id="sr-d" rows={4} maxLength={5000} value={f.body} onChange={e => setF({ ...f, body: e.target.value })} /></Field></div>
    <div className="row" style={{ gridColumn: '1/-1' }}><button className="btn pri" type="submit" disabled={m.isPending}><Icon n="send" />{m.isPending ? 'Submitting…' : 'Submit request'}</button><span className="xs muted">Typical first response: 2 working days.</span></div>
  </form></Card>
}

function SupportChat({ onHuman }: { onHuman: () => void }) {
  const toast = useToast()
  const [msgs, setMsgs] = useState<{ q: string; a?: { found: boolean; answer: string; source?: string | null } }[]>([])
  const [v, setV] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const m = useMutation({ mutationFn: (q: string) => post<{ found: boolean; answer: string; source?: string }>('/api/student/support/ask', { q }),
    onSuccess: (a, q) => setMsgs(x => x.map(y => y.q === q && !y.a ? { ...y, a } : y)), onError: (e: any, q) => { setMsgs(x => x.filter(y => y.q !== q || y.a)); toast(errText(e), true) } })
  useEffect(() => { box.current?.scrollTo({ top: box.current.scrollHeight }) }, [msgs])
  const send = () => { const q = v.trim(); if (!q || m.isPending) return; setMsgs(x => [...x, { q }]); setV(''); m.mutate(q) }
  return <div className="ia"><div className="iah"><h3>Support assistant</h3><AiTag label="Automated" /></div><div className="iab">
    <div className="chat" ref={box} style={{ maxHeight: 320, overflow: 'auto' }}><div className="msg ai"><div className="bub small">I can answer common questions about the platform and point you to the right office. For anything personal, I’ll pass you to a person.</div></div>
      {msgs.map((x, i) => <div key={i} style={{ display: 'contents' }}><div className="msg me"><div className="bub">{x.q}</div></div>
        <div className="msg ai"><div className="bub small">{x.a ? <><span className="ai-tag"><Icon n="ai" />Automated answer</span><p style={{ marginTop: 4 }}>{x.a.answer}</p>
          {x.a.source ? <div className="src"><span>FAQ: {x.a.source}</span></div> : <button className="btn sm" style={{ marginTop: 6 }} onClick={onHuman}><Icon n="user" />Talk to a person</button>}</> : <span className="typing"><i /><i /><i /></span>}</div></div></div>)}</div>
    <form className="row" style={{ flexWrap: 'nowrap' }} onSubmit={e => { e.preventDefault(); send() }}><input className="inp" aria-label="Ask the support assistant" placeholder="e.g. how do I turn on captions?" maxLength={500} value={v} onChange={e => setV(e.target.value)} />
      <button className="btn teal" aria-label="Send" disabled={m.isPending || !v.trim()}><Icon n="send" /></button></form>
    <button className="btn sm ghost" onClick={onHuman}><Icon n="user" />Talk to a person</button></div></div>
}
