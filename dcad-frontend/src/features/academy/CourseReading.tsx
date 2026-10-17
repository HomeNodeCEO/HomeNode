import { useState } from 'react';
import { ArrowRight, BookOpen, CheckCircle2 } from 'lucide-react';
import { cases, sources } from './reference';
import type { CourseModule, KnowledgeCheck, ModuleReading } from './types';

export function SourceLinks({ ids }: { ids: string[] }) {
  return <div className="academy-source-links"><span>Reference reading</span>{ids.map(id => <a key={id} href={sources[id].url} target="_blank" rel="noreferrer">{sources[id].title} ↗</a>)}</div>;
}

function CheckKnowledge({ check, id }: { check: KnowledgeCheck; id: string }) {
  const [selected, setSelected] = useState<number | null>(null);
  const [checked, setChecked] = useState(false);
  return <aside className="academy-knowledge" aria-label="Check your knowledge">
    <span className="academy-kicker">CHECK YOUR KNOWLEDGE · UNGRADED</span>
    <h4>{check.prompt}</h4>
    <fieldset disabled={checked}><legend className="academy-sr-only">Choose a response</legend>{check.options.map((option, i) => <label key={option} className={`academy-option ${selected === i ? 'selected' : ''} ${checked && i === check.answer ? 'correct' : ''}`}><input type="radio" name={id} checked={selected === i} onChange={() => setSelected(i)} /><span>{option}</span></label>)}</fieldset>
    {!checked ? <button disabled={selected === null} onClick={() => setChecked(true)}>Check my understanding</button> : <div role="status"><strong>{selected === check.answer ? 'You have it.' : 'Let’s work through it.'}</strong><p>{check.explanation}</p><button onClick={() => { setSelected(null); setChecked(false); }}>Try again</button></div>}
    <small>Practice only. This does not affect your section-exam score.</small>
  </aside>;
}

export default function CourseReading({ module, reading, position, isRead, onExam, onRead }: {
  module: CourseModule; reading: ModuleReading; position: number; isRead: boolean; onExam: () => void; onRead: () => void;
}) {
  const sourceIds = [...new Set(module.questions.flatMap(q => q.sources))];
  const caseIds = [...new Set(module.questions.map(q => q.caseId))];
  return <article className="academy-lesson academy-chapter">
    <span className="academy-kicker">CHAPTER {String(position + 1).padStart(2, '0')} · COURSE MATERIAL</span>
    <h1>{module.title}</h1><p className="academy-chapter-intro">{reading.introduction}</p>
    <div className="academy-objectives"><BookOpen size={20} /><div><h2>What you will learn</h2><ul>{reading.objectives.map(item => <li key={item}>{item}</li>)}</ul></div></div>
    <nav className="academy-chapter-toc" aria-label="In this chapter"><strong>In this chapter</strong>{reading.sections.map(section => <a href={`#${module.id}-${section.id}`} key={section.id}>{section.title}</a>)}<a href={`#${module.id}-exam`}>Section exam</a></nav>
    <details className="academy-case"><summary>Practice case facts & conventions</summary>{caseIds.map(id => <div key={id}><h3>{cases[id].name}</h3><ul>{cases[id].facts.map(f => <li key={f}>{f}</li>)}</ul></div>)}<small>All cases, rates and market scenarios are fictional teaching examples. Separate examples state their own assumptions.</small></details>
    {reading.sections.map(section => <section className="academy-reading-section" id={`${module.id}-${section.id}`} key={section.id}>
      <h2>{section.title}</h2>{section.paragraphs.map((paragraph, i) => <p key={i}>{paragraph}</p>)}
      {section.formula && <div className="academy-formula">{section.formula}</div>}
      {section.example && <div className="academy-worked-example"><span className="academy-kicker">WORKED EXAMPLE</span><h3>{section.example.title}</h3><div className="academy-table-wrap"><table><caption>{section.example.title}</caption><thead><tr>{section.example.columns.map(col => <th scope="col" key={col}>{col}</th>)}</tr></thead><tbody>{section.example.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => j === 0 ? <th scope="row" key={j}>{cell}</th> : <td key={j}>{cell}</td>)}</tr>)}</tbody></table></div><p>{section.example.explanation}</p></div>}
      {section.check && <CheckKnowledge check={section.check} id={`${module.id}-${section.id}-check`} />}
    </section>)}
    <section className="academy-chapter-summary"><h2>Before the exam</h2><p>Explain these points in your own words. If you can explain the process as well as calculate the answer, you are ready to apply the chapter.</p><ul>{reading.summary.map(item => <li key={item}>{item}</li>)}</ul></section>
    <SourceLinks ids={sourceIds} />
    <section className="academy-exam-entry" id={`${module.id}-exam`}><span className="academy-kicker">SECTION EXAM · {module.questions.length} QUESTIONS</span><h2>Put the chapter into practice.</h2><p>The exam comes after the reading. Choose all five answers, then submit to see your score and the reasoning for every choice. You can revisit the chapter and retake the exam.</p><div className="academy-actions"><button className="academy-primary" onClick={onExam}>Start section exam <ArrowRight size={17} /></button><button onClick={onRead} disabled={isRead}>{isRead ? <><CheckCircle2 size={17} /> Reading complete</> : 'Mark reading complete'}</button></div></section>
  </article>;
}
