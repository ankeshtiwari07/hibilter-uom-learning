/* Minimal, safe markdown renderer for course readings (subset in docs/curriculum-schema.md). Builds React elements — no raw HTML. */
import { Fragment, ReactNode } from 'react'

function inline(text: string, key = 'i'): ReactNode[] {
  const out: ReactNode[] = []
  const rx = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`)/g
  let last = 0, m: RegExpExecArray | null, k = 0
  while ((m = rx.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const t = m[0]
    if (t.startsWith('**')) out.push(<strong key={`${key}${k++}`}>{t.slice(2, -2)}</strong>)
    else if (t.startsWith('`')) out.push(<code key={`${key}${k++}`}>{t.slice(1, -1)}</code>)
    else out.push(<em key={`${key}${k++}`}>{t.slice(1, -1)}</em>)
    last = m.index + t.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

export function headings(md: string): { id: string; text: string }[] {
  return md.split('\n').filter(l => l.startsWith('## ')).map(l => ({ id: slug(l.slice(3)), text: l.slice(3).trim() }))
}

export function Markdown({ src }: { src: string }) {
  const lines = src.replace(/\r/g, '').split('\n')
  const blocks: ReactNode[] = []
  let i = 0, k = 0
  const isTableSep = (l: string) => /^\s*\|?\s*:?-{2,}/.test(l)
  while (i < lines.length) {
    const l = lines[i]
    if (!l.trim()) { i++; continue }
    if (l.startsWith('```')) {
      const lang = l.slice(3).trim(); const buf: string[] = []; i++
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++])
      i++
      blocks.push(<pre key={k++} className="md-code" aria-label={`${lang || 'code'} example`}><code>{buf.join('\n')}</code></pre>)
      continue
    }
    if (l.startsWith('### ')) { blocks.push(<h4 key={k++}>{inline(l.slice(4))}</h4>); i++; continue }
    if (l.startsWith('## ')) { blocks.push(<h3 key={k++} id={slug(l.slice(3))}>{inline(l.slice(3))}</h3>); i++; continue }
    if (l.startsWith('# ')) { blocks.push(<h3 key={k++}>{inline(l.slice(2))}</h3>); i++; continue }
    if (l.startsWith('> ')) {
      const buf: string[] = []
      while (i < lines.length && lines[i].startsWith('>')) buf.push(lines[i++].replace(/^>\s?/, ''))
      blocks.push(<blockquote key={k++} className="md-callout">{buf.map((b, j) => <p key={j}>{inline(b, `q${j}`)}</p>)}</blockquote>)
      continue
    }
    if (l.trim().startsWith('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const row = (r: string) => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())
      const head = row(l); i += 2; const body: string[][] = []
      while (i < lines.length && lines[i].trim().startsWith('|')) body.push(row(lines[i++]))
      blocks.push(<div key={k++} className="tbl-wrap"><table className="t"><thead><tr>{head.map((h, j) => <th key={j}>{inline(h, `h${j}`)}</th>)}</tr></thead>
        <tbody>{body.map((r, a) => <tr key={a}>{r.map((c, b) => <td key={b}>{inline(c, `c${a}${b}`)}</td>)}</tr>)}</tbody></table></div>)
      continue
    }
    if (/^\s*[-*] /.test(l)) {
      const buf: string[] = []
      while (i < lines.length && /^\s*[-*] /.test(lines[i])) buf.push(lines[i++].replace(/^\s*[-*] /, ''))
      blocks.push(<ul key={k++}>{buf.map((b, j) => <li key={j}>{inline(b, `u${j}`)}</li>)}</ul>)
      continue
    }
    if (/^\s*\d+[.)] /.test(l)) {
      const items: ReactNode[][] = []
      while (i < lines.length && (/^\s*\d+[.)] /.test(lines[i]) || (/^\s{2,}\S|^\*Answer/.test(lines[i]) && items.length))) {
        const t = lines[i++]
        if (/^\s*\d+[.)] /.test(t)) items.push([inline(t.replace(/^\s*\d+[.)] /, ''), `o${items.length}`)])
        else items[items.length - 1].push(<span key={`a${i}`} className="md-answer">{inline(t.trim(), `a${i}`)}</span>)
      }
      blocks.push(<ol key={k++}>{items.map((b, j) => <li key={j}>{b.map((x, z) => <Fragment key={z}>{x}</Fragment>)}</li>)}</ol>)
      continue
    }
    const buf: string[] = []
    while (i < lines.length && lines[i].trim() && !/^(#|>|```|\s*[-*] |\s*\d+[.)] |\s*\|)/.test(lines[i])) buf.push(lines[i++])
    if (!buf.length) { buf.push(lines[i++]) }
    blocks.push(<p key={k++}>{inline(buf.join(' '))}</p>)
  }
  return <div className="md">{blocks}</div>
}
