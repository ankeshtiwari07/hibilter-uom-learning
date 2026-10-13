import { P } from '../lib/icons'

export function Icon({ n, className = '', size = 16 }: { n: string; className?: string; size?: number }) {
  return <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.7}
    strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true"
    dangerouslySetInnerHTML={{ __html: P[n] || P.dot || '' }} />
}
