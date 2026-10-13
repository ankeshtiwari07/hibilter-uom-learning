import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react'
import { api, post } from './api'

export type Role = 'student' | 'lecturer' | 'admin'
export type Me = { id: string; email: string; role: Role; name: string; first: string; title?: string; faculty_id?: string; programme_id?: string; student_no?: string; year?: number; prefs: Record<string, any> }
type Ctx = { me: Me | null; loading: boolean; login: (e: string, p: string) => Promise<Me>; logout: () => Promise<void>; refresh: () => Promise<void>; setPrefs: (p: Record<string, any>) => void }
const AuthCtx = createContext<Ctx>(null as any)
export const useAuth = () => useContext(AuthCtx)
export const HOME: Record<Role, string> = { student: '/s-dash', lecturer: '/l-dash', admin: '/a-dash' }

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null)
  const [loading, setLoading] = useState(true)
  const refresh = useCallback(async () => {
    try { setMe(await api<Me>('/api/auth/me')) } catch { setMe(null) } finally { setLoading(false) }
  }, [])
  useEffect(() => { refresh() }, [refresh])
  useEffect(() => {
    const h = () => setMe(null); window.addEventListener('uom:unauthorized', h); return () => window.removeEventListener('uom:unauthorized', h)
  }, [])
  useEffect(() => {
    const t = me?.prefs?.theme; const r = document.documentElement
    if (t === 'dark' || t === 'light') r.setAttribute('data-theme', t); else r.removeAttribute('data-theme')
    r.style.fontSize = me?.prefs?.textSize === 'large' ? '112%' : ''
  }, [me?.prefs?.theme, me?.prefs?.textSize])
  const login = async (email: string, password: string) => { const u = await post<Me>('/api/auth/login', { email, password }); setMe(u); return u }
  const logout = async () => { try { await post('/api/auth/logout') } finally { setMe(null) } }
  const setPrefs = (p: Record<string, any>) => { setMe(m => m ? { ...m, prefs: { ...m.prefs, ...p } } : m); api('/api/auth/prefs', { method: 'PATCH', body: p }).catch(() => { }) }
  return <AuthCtx.Provider value={{ me, loading, login, logout, refresh, setPrefs }}>{children}</AuthCtx.Provider>
}
