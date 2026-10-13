import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Fragment, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon } from '../../components/Icon'
import { Card, Empty, ErrorBox, Loading, Modal, PageHead, Seg, Switch, useToast } from '../../components/ui'
import { download, get, put } from '../../lib/api'
import { errText } from './shared'

type Ev = { id: string; kind: string; title: string; start: string; end?: string | null; location?: string | null; course_code?: string | null; source: string; link?: string | null; reminder: boolean }
const KIND: Record<string, string> = { cls: 'Class', due: 'Deadline', exam: 'Examination', uni: 'University event', vf: 'Virtual lesson' }
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const hm = (s: string) => new Date(s).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
const mondayOf = (d: Date) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x }
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x }

export default function Calendar() {
  const toast = useToast()
  const [view, setView] = useState<'day' | 'week' | 'month'>('month')
  const [anchor, setAnchor] = useState(() => new Date())
  const [open, setOpen] = useState<Ev | null>(null)
  const monthStart = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
  const gridStart = view === 'month' ? mondayOf(monthStart) : view === 'week' ? mondayOf(anchor) : new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate())
  const days = view === 'month' ? 42 : view === 'week' ? 7 : 1
  const from = gridStart, to = addDays(gridStart, days)
  const q = useQuery({ queryKey: ['s-cal', from.toISOString(), to.toISOString()], queryFn: () => get<Ev[]>(`/api/student/calendar?start=${encodeURIComponent(from.toISOString())}&end=${encodeURIComponent(to.toISOString())}`) })
  const evs = (d: Date) => (q.data || []).filter(e => ymd(new Date(e.start)) === ymd(d))
  const today = ymd(new Date())
  const step = (n: number) => setAnchor(a => view === 'month' ? new Date(a.getFullYear(), a.getMonth() + n, 1) : addDays(a, n * (view === 'week' ? 7 : 1)))
  const title = view === 'month' ? anchor.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
    : view === 'week' ? `Week of ${gridStart.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}` : anchor.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
  const chip = (e: Ev) => <button key={e.id} className={`ev ${e.kind}`} onClick={() => setOpen(e)} title={`${KIND[e.kind] || 'Event'}: ${e.title}`} style={{ textAlign: 'left', font: 'inherit', fontSize: 11, width: '100%', borderTop: 0, borderRight: 0, borderBottom: 0, flex: 'none' }}>
    {e.start.includes('T23:59') ? '' : `${hm(e.start)} `}{e.title}</button>
  const exportIcs = () => download('/api/student/calendar.ics', 'uom-timetable.ics').then(() => toast('Calendar exported (.ics)')).catch(e => toast(errText(e), true))
  return <>
    <PageHead no={10} title="Timetable" sub={`Classes, deadlines, examinations and university events · ${title}`}
      actions={<><Seg options={[['day', 'Day'], ['week', 'Week'], ['month', 'Month']]} value={view} onChange={v => setView(v as any)} /><button className="btn" onClick={exportIcs}><Icon n="download" />Export .ics</button></>} />
    <div className="row sb"><div className="row"><button className="btn sm" onClick={() => step(-1)} aria-label="Previous"><Icon n="back" /></button><button className="btn sm" onClick={() => setAnchor(new Date())}>Today</button>
      <button className="btn sm" onClick={() => step(1)} aria-label="Next"><Icon n="chev" /></button><b>{title}</b></div>
      <div className="legend"><span><i style={{ background: 'var(--info)' }} />Class</span><span><i style={{ background: 'var(--teal)' }} />Virtual lesson</span><span><i style={{ background: 'var(--warn)' }} />Deadline</span><span><i style={{ background: 'var(--bad)' }} />Examination</span><span><i style={{ background: 'var(--gold)' }} />University event</span></div></div>
    {q.isLoading ? <Loading label="Loading timetable…" /> : q.error ? <ErrorBox error={q.error} retry={() => q.refetch()} /> : view === 'month'
      ? <div style={{ overflowX: 'auto' }}><div className="cal" style={{ minWidth: 560 }}>{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => <div className="dh" key={d}>{d}</div>)}
        {Array.from({ length: 42 }, (_, i) => { const d = addDays(gridStart, i); return <div key={i} className={`dc ${d.getMonth() !== anchor.getMonth() ? 'off' : ''} ${ymd(d) === today ? 'today' : ''}`}>
          <button className="dn link-btn" style={{ textDecoration: 'none', color: 'inherit', alignSelf: 'flex-start' }} onClick={() => { setAnchor(d); setView('day') }} aria-label={d.toDateString()}>{d.getDate()}</button>{evs(d).map(chip)}</div> })}</div></div>
      : view === 'week' ? <WeekGrid start={gridStart} evs={evs} chip={chip} today={today} />
        : <Card title={title}>{evs(anchor).length ? <div className="list">{evs(anchor).map(e => <div className="li" key={e.id}><div className={`ic ${e.kind === 'vf' ? 'teal' : e.kind === 'due' ? 'warn' : e.kind === 'exam' ? 'bad' : e.kind === 'uni' ? 'gold' : ''}`}><Icon n={e.kind === 'due' ? 'clip' : e.kind === 'exam' ? 'award' : e.kind === 'vf' ? 'cap' : 'clock'} /></div>
          <div className="bd"><div className="tt">{e.title}</div><div className="ds">{KIND[e.kind]} · {hm(e.start)}{e.end ? `–${hm(e.end)}` : ''}{e.location ? ` · ${e.location}` : ''}</div></div><button className="btn sm" onClick={() => setOpen(e)}>Details</button></div>)}</div>
          : <Empty icon="cal" title="No events on this day" />}</Card>}
    {open && <EventModal e={open} onClose={() => setOpen(null)} />}
  </>
}

function WeekGrid({ start, evs, chip, today }: { start: Date; evs: (d: Date) => Ev[]; chip: (e: Ev) => JSX.Element; today: string }) {
  const days = Array.from({ length: 5 }, (_, i) => addDays(start, i))
  const weekend = [addDays(start, 5), addDays(start, 6)].flatMap(evs)
  const hours = Array.from({ length: 10 }, (_, i) => 8 + i)
  const at = (d: Date, h: number) => evs(d).filter(e => { const x = new Date(e.start).getHours(); return h === 8 ? x <= 8 : h === 17 ? x >= 17 : x === h })
  return <><div style={{ overflowX: 'auto' }}><div className="week" style={{ minWidth: 600 }}>
    <div />{days.map(d => <div key={ymd(d)} style={{ fontWeight: 600, background: ymd(d) === today ? 'var(--teal-soft)' : 'var(--surface-2)' }}>{d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' })}</div>)}
    {hours.map(h => <Fragment key={h}><div className="xs muted">{h === 8 ? '≤ 8:00' : h === 17 ? '17:00 +' : `${h}:00`}</div>{days.map(d => <div key={ymd(d) + h}>{at(d, h).map(chip)}</div>)}</Fragment>)}
  </div></div>{weekend.length > 0 && <Card title="Weekend">{weekend.map(chip)}</Card>}</>
}

function EventModal({ e, onClose }: { e: Ev; onClose: () => void }) {
  const nav = useNavigate(); const toast = useToast(); const qc = useQueryClient()
  const [rem, setRem] = useState(e.reminder)
  const m = useMutation({ mutationFn: () => put(`/api/student/calendar/reminders/${e.id}`, { on: rem }),
    onSuccess: () => { toast(rem ? 'Reminder saved — included in your .ics export' : 'Reminder removed'); qc.invalidateQueries({ queryKey: ['s-cal'] }); onClose() }, onError: (x: any) => toast(errText(x), true) })
  const d = new Date(e.start)
  return <Modal title={e.title} onClose={onClose} footer={<>{e.link && <button className="btn" onClick={() => nav(e.link!)}>Open {e.kind === 'exam' ? 'assessment' : 'item'}</button>}<button className="btn" onClick={onClose}>Close</button>
    <button className="btn pri" disabled={m.isPending || rem === e.reminder} onClick={() => m.mutate()}>Save</button></>}>
    <dl className="kv"><dt>Date</dt><dd>{d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</dd>
      <dt>Time</dt><dd>{hm(e.start)}{e.end ? `–${hm(e.end)}` : ''}</dd><dt>Type</dt><dd>{KIND[e.kind] || 'Event'}</dd>
      {e.course_code && <><dt>Course</dt><dd>{e.course_code}</dd></>}{e.location && <><dt>Location</dt><dd>{e.location}</dd></>}
      <dt>Source</dt><dd>{e.source === 'assessment' ? 'Assessment due date (added automatically)' : 'University timetable'}</dd></dl>
    <Switch id="ev-rem" checked={rem} onChange={setRem} label="Remind me 1 hour before" />
  </Modal>
}
