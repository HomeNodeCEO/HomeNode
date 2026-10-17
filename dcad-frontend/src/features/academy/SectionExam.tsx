import { useState } from 'react';
import { ArrowRight, Bookmark, CheckCircle2 } from 'lucide-react';
import { cases } from './reference';
import type { Progress, Question } from './types';
import { SourceLinks } from './CourseReading';

export default function SectionExam({ title, questions, progress, onSubmit, onBookmark, onReading, onFinish, finishLabel }: {
  title: string; questions: Question[]; progress: Progress; onSubmit: (answers: Record<string, number>) => void; onBookmark: (id: string) => void; onReading: () => void; onFinish: () => void; finishLabel: string;
}) {
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [submitted, setSubmitted] = useState(false);
  const answered = questions.filter(q => Number.isInteger(answers[q.id])).length;
  const correct = questions.filter(q => answers[q.id] === q.answer).length;
  return <article className="academy-lesson academy-exam">
    <span className="academy-kicker">{questions.length === 5 ? 'SECTION EXAM' : 'KNOWLEDGE REVIEW'}</span><h1>{title}</h1>
    <p>Use the case facts and the assumptions in each question. Answer every question before submitting. Explanations appear after submission.</p>
    <button onClick={onReading}>← Return to course material</button>
    {submitted && <section className="academy-exam-score" role="status"><span className="academy-kicker">THIS ATTEMPT</span><h2>{correct} / {questions.length} correct · {Math.round(correct / questions.length * 100)}%</h2><p>{correct === questions.length ? 'All answers correct. Review the explanations, then continue to the next chapter.' : 'Review the explanations below and revisit any concept that needs another pass.'} Your original first-attempt answers remain in the dashboard.</p></section>}
    <form onSubmit={event => { event.preventDefault(); if (answered !== questions.length || submitted) return; onSubmit(answers); setSubmitted(true); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>
      {questions.map((q, index) => <section key={q.id} className="academy-question" aria-label={`Question ${index + 1}`}>
        <div className="academy-section-heading"><span className="academy-kicker">QUESTION {index + 1} OF {questions.length}</span><button type="button" className="academy-bookmark" aria-pressed={progress.bookmarks.includes(q.id)} onClick={() => onBookmark(q.id)}><Bookmark size={16} fill={progress.bookmarks.includes(q.id) ? 'currentColor' : 'none'} />{progress.bookmarks.includes(q.id) ? 'Saved' : 'Save for review'}</button></div>
        <details className="academy-case"><summary>{cases[q.caseId].name} · case facts</summary><ul>{cases[q.caseId].facts.map(fact => <li key={fact}>{fact}</li>)}</ul><small>Fictional case. The question specifies any changes to these assumptions.</small></details>
        <fieldset disabled={submitted}><legend>{q.prompt}</legend>{q.options.map((option, i) => <label key={option} className={`academy-option ${answers[q.id] === i ? 'selected' : ''} ${submitted && i === q.answer ? 'correct' : ''} ${submitted && answers[q.id] === i && i !== q.answer ? 'incorrect' : ''}`}><input type="radio" name={q.id} checked={answers[q.id] === i} onChange={() => setAnswers(previous => ({ ...previous, [q.id]: i }))} /><span className="academy-option-letter">{'ABCD'[i]}</span><span>{option}</span>{submitted && i === q.answer && <CheckCircle2 size={18} />}</label>)}</fieldset>
        {submitted && <div className="academy-feedback"><strong>{answers[q.id] === q.answer ? 'Correct.' : `Correct answer: ${'ABCD'[q.answer]}.`}</strong><p>{q.explanations[q.answer]}</p>{q.formula && <div className="academy-formula">{q.formula}</div>}<details><summary>Why the other choices miss</summary>{q.explanations.map((explanation, i) => i !== q.answer && <p key={i}><strong>{'ABCD'[i]}.</strong> {explanation}</p>)}</details><p><strong>Remember:</strong> {q.takeaway}</p><SourceLinks ids={q.sources} /></div>}
      </section>)}
      {!submitted && <div className="academy-exam-submit"><p aria-live="polite">{answered} of {questions.length} questions answered. {answered < questions.length ? 'Answer the remaining questions to submit.' : 'Ready to submit.'}</p><button type="submit" className="academy-primary" disabled={answered !== questions.length}>Submit {questions.length === 5 ? 'section exam' : 'review'}</button></div>}
    </form>
    {submitted && <div className="academy-actions academy-exam-submit"><button onClick={() => { setAnswers({}); setSubmitted(false); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>Retake this set</button><button className="academy-primary" onClick={onFinish}>{finishLabel} <ArrowRight size={17} /></button></div>}
  </article>;
}
