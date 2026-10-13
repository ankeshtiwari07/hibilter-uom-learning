/* AI study assistant chat pieces shared by the Assistant page (S06) and the lesson player (S05). */
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { Icon } from '../../components/Icon'
import { useToast } from '../../components/ui'
import { post } from '../../lib/api'
import { errText } from './shared'

export type Turn = { id: number; course_id: string; question: string; answer: string; citations: { id: string; source: string; page?: number | null }[]
  grounded: boolean; engine: string; rating: number | null; at: string }

const ENGINE: Record<string, string> = { claude: 'Claude', extractive: 'extract from approved material', retrieval: 'nothing found', policy: 'assessment policy', prepared: 'prepared answer' }

export function AnswerBubble({ t, onRate, rating }: { t: Turn; onRate?: (r: number) => void; rating?: number | null }) {
  const r = rating !== undefined ? rating : t.rating
  return <div className="msg ai"><div className="bub">
    <span className="ai-tag"><Icon n="ai" />{t.engine === 'policy' || t.engine === 'retrieval' ? 'Automated reply' : 'AI-generated'} · {ENGINE[t.engine] || t.engine}</span>
    <div style={{ marginTop: 6, whiteSpace: 'pre-line' }}>{t.answer}</div>
    {t.citations.length ? <div className="src">{t.citations.map(c => <span key={c.id}><Icon n="file" /> {c.source}{c.page != null ? `, part ${c.page}` : ''}</span>)}</div>
      : <div className="src"><span>{t.engine === 'policy' ? 'Assessment integrity policy' : 'No matching source in approved material'}</span></div>}
    {onRate && <div className="row" style={{ marginTop: 6, gap: 4 }}><span className="xs muted">Was this helpful?</span>
      <button className={`btn sm ${r === 1 ? 'teal' : 'ghost'}`} aria-pressed={r === 1} aria-label="Helpful" onClick={() => onRate(r === 1 ? 0 : 1)}>👍</button>
      <button className={`btn sm ${r === -1 ? 'pri' : 'ghost'}`} aria-pressed={r === -1} aria-label="Not helpful" onClick={() => onRate(r === -1 ? 0 : -1)}>👎</button></div>}
  </div></div>
}

export function useRate() {
  const toast = useToast()
  const [ratings, setRatings] = useState<Record<number, number | null>>({})
  const m = useMutation({
    mutationFn: ({ id, rating }: { id: number; rating: number }) => post<{ id: number; rating: number | null }>(`/api/student/assistant/turns/${id}/rate`, { rating }),
    onMutate: ({ id, rating }) => setRatings(x => ({ ...x, [id]: rating || null })),
    onSuccess: r => { setRatings(x => ({ ...x, [r.id]: r.rating })); toast(r.rating ? 'Thanks — your rating helps the course team improve the material.' : 'Rating removed') },
    onError: (e: any) => toast(errText(e), true),
  })
  return { ratings, rate: (id: number, rating: number) => m.mutate({ id, rating }) }
}

export function useAsk(onDone: (t: Turn) => void) {
  const toast = useToast()
  return useMutation({
    mutationFn: (v: { course_id: string; q: string; mode?: string }) => post<Turn>('/api/student/assistant/ask', { mode: 'lesson', ...v }),
    onSuccess: onDone,
    onError: (e: any) => toast(errText(e), true),
  })
}

export function Pending({ q }: { q: string }) {
  return <><div className="msg me"><div className="bub">{q}</div></div><div className="msg ai"><div className="bub"><span className="typing"><i /><i /><i /></span></div></div></>
}
