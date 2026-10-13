import { ReactNode, Suspense } from "react"
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { Shell } from './components/Shell'
import { Loading } from './components/ui'
import { HOME, Role, useAuth } from './lib/auth'
import Login from './pages/Login'
import { ROUTES } from './routes'

function Guard({ roles, crumbs, children }: { roles: Role[]; crumbs: string[]; children: ReactNode }) {
  const { me, loading } = useAuth(); const loc = useLocation()
  if (loading) return <Loading label="Signing you in…" />
  if (!me) return <Navigate to="/login" state={{ from: loc.pathname + loc.search }} replace />
  if (!roles.includes(me.role)) return <Navigate to={HOME[me.role]} replace />
  return <Shell crumbs={crumbs}><Suspense fallback={<Loading />}>{children}</Suspense></Shell>
}

export default function App() {
  const { me, loading } = useAuth()
  return <Routes>
    <Route path="/login" element={<Login />} />
    {ROUTES.map(r => <Route key={r.path} path={r.path} element={<Guard roles={r.roles} crumbs={r.crumbs}><r.C /></Guard>} />)}
    <Route path="*" element={loading ? <Loading /> : <Navigate to={me ? HOME[me.role] : '/login'} replace />} />
  </Routes>
}
