import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { get, post } from '../lib/api'
import { rel } from '../lib/format'
import { Icon } from './Icon'
import { Empty, Modal } from './ui'

type N = { id: string; title: string; body: string; at: string; unread: boolean; link?: string; kind: string }

export function NotificationsButton() {
  const [open, setOpen] = useState(false)
  const nav = useNavigate()
  const q = useQuery({ queryKey: ['notifications'], queryFn: () => get<N[]>('/api/notifications'), refetchInterval: 60000, retry: false })
  const items = q.data || []
  const unread = items.filter(n => n.unread).length
  return <>
    <button className="iconbtn" onClick={() => setOpen(true)} aria-label={`Notifications${unread ? ` (${unread} unread)` : ''}`}><Icon n="bell" />{unread > 0 && <span className="dot" />}</button>
    {open && <Modal title="Notifications" onClose={() => setOpen(false)} footer={unread ? <button className="btn" onClick={async () => { await post('/api/notifications/read-all'); q.refetch() }}>Mark all as read</button> : undefined}>
      {items.length ? <div className="list">{items.map(n => <button key={n.id} className={`li ${n.unread ? 'unread' : ''}`} style={{ textAlign: 'left', background: 'none', border: 0, cursor: 'pointer', borderBottom: '1px solid var(--line)' }}
        onClick={() => { setOpen(false); if (n.link) nav(n.link) }}>
        <span className={`ic ${n.kind === 'due' ? 'warn' : 'teal'}`}><Icon n={n.kind === 'due' ? 'clock' : n.kind === 'grade' ? 'award' : 'mega'} /></span>
        <span className="bd"><span className="tt">{n.title}</span><span className="ds" style={{ display: 'block' }}>{n.body}</span><span className="xs faint">{rel(n.at)}</span></span>
      </button>)}</div> : <Empty title="You're all caught up" />}
    </Modal>}
  </>
}
