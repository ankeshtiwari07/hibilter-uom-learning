import { Icon } from '../components/Icon'
import { SlideBody, isSlideSpec } from '../components/SlideView'

type Seg = { title: string; slide?: unknown }

function Frame({ i, total, title, course, children }: { i: number; total: number; title: string; course?: string; children: React.ReactNode }) {
  return <div className="slide"><div className="sh"><Icon n="file" /><span>Slide {i} of {total} · {title}</span><span className="sp" /><span className="xs">Approved material · {course || 'course'} notes</span></div><div className="sb">{children}</div></div>
}

export function Slide({ state, seg, segIndex, segCount, lesson }: { state: string; seg?: Seg; segIndex: number; segCount: number; lesson: any }) {
  const total = segCount + 2
  if (state === 'IDLE' || state === 'WELCOME') return <Frame i={1} total={total} title="Today’s lesson" course={lesson.course_code}>
    <h3>{lesson.title}</h3><p className="muted small">{lesson.module} · about {lesson.dur} minutes · {segCount} checkpoints</p>
    <ul>{(lesson.objectives || []).map((o: string) => <li key={o}>{o}</li>)}</ul></Frame>
  if (state === 'COMPLETED' && lesson.summary?.length) return <Frame i={total} total={total} title="Summary" course={lesson.course_code}>
    <h3>Key ideas</h3><ul>{lesson.summary.map((x: string) => <li key={x}>{x}</li>)}</ul></Frame>
  if (state === 'COMPLETED') return <Frame i={total} total={total} title="Summary" course={lesson.course_code}>
    <h3>Key ideas</h3><ul><li><b>AI</b> is the broad field; <b>ML</b> is the subset that learns patterns from data.</li>
      <li><b>Supervised learning</b> uses labels — the correct answers — to check and correct predictions.</li>
      <li><b>Biased data</b> leads to less accurate or unfair outcomes; humans stay in the loop.</li></ul></Frame>
  if (!seg) return null
  const i = segIndex + 2
  if (isSlideSpec(seg.slide)) return <Frame i={i} total={total} title={seg.title} course={lesson.course_code}><SlideBody s={seg.slide} /></Frame>
  if (seg.slide === 'nested') return <Frame i={i} total={total} title={seg.title} course={lesson.course_code}>
    <h3>AI ⊃ Machine learning ⊃ Deep learning</h3>
    <svg className="dg" viewBox="0 0 420 200" role="img" aria-label="Nested circles: AI contains machine learning, which contains deep learning">
      <ellipse cx="210" cy="100" rx="204" ry="94" fill="var(--info-soft)" stroke="var(--c1)" strokeWidth="1.5" />
      <ellipse cx="258" cy="116" rx="140" ry="70" fill="var(--teal-soft)" stroke="var(--c2)" strokeWidth="1.5" />
      <ellipse cx="318" cy="142" rx="68" ry="36" fill="var(--gold-soft)" stroke="var(--c3)" strokeWidth="1.5" />
      <text x="26" y="58" fontWeight="700">Artificial intelligence</text><text x="26" y="75" fontSize="11">human-like tasks</text>
      <text x="134" y="106" fontWeight="700">Machine learning</text><text x="134" y="123" fontSize="11">learns from data</text>
      <text x="318" y="146" textAnchor="middle" fontWeight="700">Deep learning</text></svg>
    <ul><li>Rule-based chess engine → AI, not ML</li><li>Spam filter trained on labelled emails → ML</li><li>Speech recognition with neural networks → deep learning</li></ul></Frame>
  if (seg.slide === 'pipeline') {
    const box = (x: number, t: string, s: string, c: string) => <g key={t}><rect x={x} y="40" width="88" height="62" rx="8" fill="var(--surface)" stroke={c} strokeWidth="1.5" />
      <text x={x + 44} y="66" textAnchor="middle" fontWeight="700">{t}</text><text x={x + 44} y="84" textAnchor="middle" fontSize="10.5">{s}</text></g>
    return <Frame i={i} total={total} title={seg.title} course={lesson.course_code}>
      <h3>Supervised learning</h3>
      <svg className="dg" viewBox="0 0 420 150" role="img" aria-label="Pipeline: labelled data, training, model, prediction">
        {box(4, 'Labelled', 'data + answers', 'var(--c1)')}{box(112, 'Training', 'adjust to labels', 'var(--c2)')}{box(220, 'Model', 'learnt pattern', 'var(--c2)')}{box(328, 'Prediction', 'on new data', 'var(--c3)')}
        <defs><marker id="arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 8 4 0 8z" fill="var(--muted)" /></marker></defs>
        <path d="M94 71h16M202 71h16M310 71h16" stroke="var(--muted)" strokeWidth="1.5" markerEnd="url(#arr)" />
        <path d="M156 102c0 26-108 26-108 0" stroke="var(--c2)" strokeDasharray="4 3" fill="none" />
        <text x="102" y="138" textAnchor="middle" fontSize="10.5">compare prediction with label → reduce error</text></svg>
      <ul><li>Example: emails labelled <i>spam</i> / <i>not spam</i></li><li>Features: words, sender, links</li><li>Test on unseen data; big gap = overfitting</li></ul></Frame>
  }
  return <Frame i={i} total={total} title={seg.title} course={lesson.course_code}>
    <h3>Machine learning at work</h3>
    <div className="g g2" style={{ gap: 8 }}>{[['Energy', 'Forecasting electricity demand'], ['Agriculture', 'Sugar-cane yield from satellite imagery'], ['Finance', 'Flagging fraudulent card transactions'], ['Tourism', 'Predicting visitor arrivals']].map(([k, v]) =>
      <div key={k} className="card flat" style={{ padding: 10 }}><div className="eyebrow">{k}</div><div className="small">{v}</div></div>)}</div>
    <div className="note warn"><Icon n="alert" /><div><b>Bias risk:</b> unrepresentative training data can make a model less accurate or unfair for some groups. Keep humans in the loop.</div></div>
  </Frame>
}
