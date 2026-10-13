import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { ToastProvider } from './components/ui'
import { AuthProvider } from './lib/auth'
import './styles/app.css'
import './styles/extra.css'

const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 20_000, retry: (n, e: any) => n < 2 && e?.status !== 401 && e?.status !== 403 && e?.status !== 404, refetchOnWindowFocus: false } } })

createRoot(document.getElementById('app')!).render(
  <StrictMode><QueryClientProvider client={qc}><BrowserRouter><AuthProvider><ToastProvider><App /></ToastProvider></AuthProvider></BrowserRouter></QueryClientProvider></StrictMode>,
)
