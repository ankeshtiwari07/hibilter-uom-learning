import { ReactNode, useEffect, useState } from 'react'
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'
import { HOME, Role, useAuth } from '../lib/auth'
import { Icon } from './Icon'
import { Avatar, Modal } from './ui'
import { NotificationsButton } from './Notifications'

type NavItem = [string, string, string, string?]
export const NAV: Record<Role, [string, NavItem[]][]> = {
  student: [
    ['Learn', [['/s-dash', 'home', 'Dashboard'], ['/s-classroom', 'cap', 'Virtual classroom', 'hero'], ['/s-catalogue', 'grid', 'Course catalogue'], ['/s-courses', 'book', 'My courses'], ['/s-lesson', 'play', 'Lesson player'], ['/s-ai', 'ai', 'AI study assistant']]],
    ['Assess', [['/s-assign', 'clip', 'Assignments'], ['/s-quiz', 'checkc', 'Quizzes'], ['/s-progress', 'line', 'My progress']]],
    ['Campus', [['/s-cal', 'cal', 'Timetable'], ['/s-news', 'mega', 'Announcements'], ['/s-support', 'help', 'Support'], ['/s-profile', 'user', 'Profile & settings']]],
  ],
  lecturer: [
    ['Teach', [['/l-dash', 'home', 'Dashboard'], ['/l-courses', 'book', 'Course management'], ['/l-editor', 'edit', 'Lesson editor'], ['/l-builder', 'clip', 'Assessment builder'], ['/l-grading', 'checkc', 'Submissions & grading']]],
    ['Virtual faculty', [['/vf-gallery', 'cap', 'Faculty library', 'hero'], ['/vf-config', 'cog', 'Configure avatar'], ['/vf-review', 'flag', 'Review queue'], ['/vf-analytics', 'chart', 'Virtual class analytics']]],
    ['Insight', [['/l-analytics', 'line', 'Class analytics'], ['/l-comms', 'mega', 'Communication']]],
  ],
  admin: [
    ['Leadership', [['/a-dash', 'home', 'Institutional overview'], ['/a-perf', 'line', 'Performance analytics'], ['/vf-analytics', 'cap', 'Virtual faculty analytics', 'hero'], ['/a-risk', 'flag', 'Learners for follow-up'], ['/a-reports', 'csv', 'Reporting centre']]],
    ['Administration', [['/a-structure', 'bldg', 'Academic structure'], ['/a-directory', 'users', 'Student directory'], ['/a-notices', 'mega', 'Notices & calendar'], ['/a-users', 'shield', 'Users & roles'], ['/vf-config', 'cog', 'Virtual faculty settings'], ['/a-settings', 'lock', 'Settings & audit']]],
  ],
}
const ROLE_LABEL: Record<Role, string> = { student: 'Student', lecturer: 'Lecturer', admin: 'Administrator' }

export function Shell({ crumbs, children }: { crumbs: string[]; children: ReactNode }) {
  const { me, logout, setPrefs } = useAuth()
  const [open, setOpen] = useState(false)
  const [acct, setAcct] = useState(false)
  const [q, setQ] = useState('')
  const loc = useLocation(); const nav = useNavigate()
  useEffect(() => { setOpen(false); window.scrollTo(0, 0) }, [loc.pathname])
  if (!me) return null
  const theme = me.prefs?.theme || 'system'
  const cycleTheme = () => setPrefs({ theme: theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark' })
  return <>
    <a className="sr" href="#main">Skip to content</a>
    <div className="app">
      <aside className={`side ${open ? 'open' : ''}`} aria-label="Main navigation">
        <div className="brand"><img className="uom" src="/brand/uom.png" alt="University of Mauritius" />
          <div className="x"><span>×</span><img src="/brand/hibilter.png" alt="" /><b>Hibilter</b> AI Learning Platform</div></div>
        <nav className="nav">{NAV[me.role].map(([g, items]) => <div key={g} style={{ display: 'contents' }}>
          <div className="grp">{g}</div>
          {items.filter(([to]) => !(me.demo && to === '/vf-gallery')).map(([to, ic, label, hero]) => <NavLink key={to} to={to} className={({ isActive }) => `${isActive || loc.pathname.startsWith(to + '/') || (to === '/s-courses' && loc.pathname.startsWith('/s-course/')) ? 'on' : ''} ${hero || ''}`}>
            <Icon n={ic} /><span>{label}</span>{to === '/s-classroom' && <span className="pill">AI</span>}</NavLink>)}
        </div>)}</nav>
        <div className="foot">Concept platform with synthetic data — not an official University system. Logo use subject to University permission.</div>
      </aside>
      <div className={`side-scrim ${open ? 'on' : ''}`} onClick={() => setOpen(false)} />
      <div className="main">
        <header className="top">
          <button className="iconbtn burger" onClick={() => setOpen(true)} aria-label="Open navigation"><Icon n="menu" /></button>
          <div className="crumbs" aria-label="Breadcrumb"><Link to={HOME[me.role]}>Home</Link>{crumbs.map((c, i) => <span key={i} style={{ display: 'contents' }}><span className="sep">/</span><span>{c}</span></span>)}</div>
          <span className="sp" />
          <form className="search" role="search" onSubmit={e => { e.preventDefault(); if (q.trim()) nav(`/search?q=${encodeURIComponent(q.trim())}`) }}>
            <Icon n="search" /><input value={q} onChange={e => setQ(e.target.value)} placeholder="Search courses, lessons, people…" aria-label="Search" /></form>
          <button className="iconbtn" onClick={cycleTheme} aria-label={`Theme: ${theme}`} title={`Theme: ${theme}`}><Icon n={theme === 'dark' ? 'moon' : theme === 'light' ? 'sun' : 'eye'} /></button>
          <NotificationsButton />
          <button className="me" onClick={() => setAcct(true)} aria-label="Account"><Avatar name={me.name} kind={me.role === 'admin' ? 'g' : 't'} /><span className="who">{me.name}<small>{ROLE_LABEL[me.role]}</small></span></button>
        </header>
        <main className="page" id="main" tabIndex={-1}>{children}</main>
      </div>
    </div>
    {acct && <Modal title="Account" onClose={() => setAcct(false)} footer={<>
      <button className="btn" onClick={() => { setAcct(false); nav(me.role === 'student' ? '/s-profile' : me.role === 'admin' ? '/a-settings' : '/vf-config') }}><Icon n="user" />Profile & settings</button>
      <button className="btn danger" onClick={async () => { await logout(); nav('/login') }}><Icon n="out" />Sign out</button></>}>
      <div className="row"><Avatar name={me.name} size={44} kind="t" /><div><b>{me.name}</b><div className="small muted">{me.email}</div><div className="xs muted">{me.title || ROLE_LABEL[me.role]}</div></div></div>
    </Modal>}
  </>
}
