export const initials = (n = '') => n.replace(/^(Dr\.|Prof\.|Ms\.|Mr\.)\s*/, '').split(/\s+/).map(x => x[0]).slice(0, 2).join('').toUpperCase()
export const pct = (v: number | null | undefined) => (v == null ? '—' : Math.round(v) + '%')
export function fmtDate(s?: string | null, time = false) {
  if (!s) return '—'
  const d = new Date(s)
  const day = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  return time ? `${day} · ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : day
}
export function daysTo(s?: string | null) {
  if (!s) return null
  return Math.round((new Date(s).getTime() - Date.now()) / 864e5)
}
export function rel(s?: string | null) {
  if (!s) return '—'
  const m = Math.round((Date.now() - new Date(s).getTime()) / 60000)
  if (m < 1) return 'just now'; if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60); if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24); return d < 7 ? `${d} d ago` : fmtDate(s)
}
