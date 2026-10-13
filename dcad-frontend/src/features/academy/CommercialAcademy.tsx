import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, BookOpen, Bookmark, CheckCircle2, ChevronLeft, ChevronRight, GraduationCap, RotateCcw } from 'lucide-react';
import { useApplicationAuth } from '../auth/ApplicationAuth';
import { modules, questions, courseVersion } from './course';
import { cases, interviewPrompts, sources } from './reference';
import { emptyProgress, parseProgress, progressStats, recordAnswer } from './progress';
import type { Progress, Question } from './types';
import ModelLab from './ModelLab';
import './academy.css';
type Tab = 'overview' | 'learn' | 'lab' | 'interview' | 'sources';
const allIds = questions.map(q => q.id);
function SourceLinks({ ids }: {
    ids: string[];
}) {
    return <div className="academy-source-links"><span>Reference reading</span>{ids.map(id => <a key={id} href={sources[id].url} target="_blank" rel="noreferrer">{sources[id].title} ↗</a>)}</div>;
}
function Lesson({ question, progress, onAnswer, onBookmark, onNext, onPrevious, position, count }: {
    question: Question;
    progress: Progress;
    onAnswer: (choice: number) => void;
    onBookmark: () => void;
    onNext: () => void;
    onPrevious: () => void;
    position: number;
    count: number;
}) {
    const record = progress.answers[question.id];
    const [showQuestion, setShowQuestion] = useState(false);
    const [selected, setSelected] = useState<number | null>(null);
    const [submitted, setSubmitted] = useState(false);
    const property = cases[question.caseId];
    const bookmarked = progress.bookmarks.includes(question.id);
    return <article className="academy-lesson">
    <div className="academy-section-heading"><span className="academy-kicker">LESSON {position + 1} OF {count} {question.essential ? '• CORE CONCEPT' : ''}</span><button className="academy-bookmark" aria-pressed={bookmarked} onClick={onBookmark}><Bookmark size={16} fill={bookmarked ? 'currentColor' : 'none'}/>{bookmarked ? 'Saved for review' : 'Save for review'}</button></div>
    <h2>{question.title}</h2>
    <div className="academy-case"><span className="academy-kicker" style={{ color: property.color }}>{property.tag} CASE</span><h3>{property.name}</h3><p>{property.detail}</p><details><summary>View case facts</summary><ul>{property.facts.map(f => <li key={f}>{f}</li>)}</ul></details><small>Fictional practice case. Each question states any changes to the base assumptions.</small></div>
    <div className="academy-reading"><span className="academy-kicker">FIRST, THE CONCEPT</span>{question.lesson.map((paragraph, i) => <p key={i}>{paragraph}</p>)}{question.formula && <div className="academy-formula">{question.formula}</div>}</div>
    {!showQuestion ? <button className="academy-primary" onClick={() => setShowQuestion(true)}>Try the case question <ArrowRight size={17}/></button> : <section className="academy-question" aria-label="Practice question">
      <h3>{question.prompt}</h3>
      <fieldset disabled={submitted}><legend className="academy-sr-only">Choose one answer</legend>{question.options.map((option, i) => <label key={option} className={`academy-option ${selected === i ? 'selected' : ''} ${submitted && i === question.answer ? 'correct' : ''} ${submitted && selected === i && i !== question.answer ? 'incorrect' : ''}`}><input type="radio" name={question.id} checked={selected === i} onChange={() => setSelected(i)}/><span className="academy-option-letter">{'ABCD'[i]}</span><span>{option}</span>{submitted && i === question.answer && <CheckCircle2 size={18}/>}</label>)}</fieldset>
      {!submitted ? <button className="academy-primary" disabled={selected === null} onClick={() => { if (selected !== null) {
                onAnswer(selected);
                setSubmitted(true);
            } }}>Check answer</button> : <div className="academy-feedback" aria-live="polite">
        <strong>{selected === question.answer ? 'Correct — here’s the reasoning.' : 'Review this one — the correct answer is ' + 'ABCD'[question.answer] + '.'}</strong>
        <p>{question.explanations[question.answer]}</p>
        <details><summary>Why the other choices miss</summary>{question.explanations.map((explanation, i) => i !== question.answer ? <p key={i}><strong>{'ABCD'[i]}.</strong> {explanation}</p> : null)}</details>
        <div className="academy-takeaway"><BookOpen size={18}/><span>{question.takeaway}</span></div>
        <button onClick={() => { setSelected(null); setSubmitted(false); }}>Try again</button>
      </div>}
    </section>}
    {record && !submitted && <p className="academy-small">Previous attempt: {record.selected === question.answer ? 'correct' : 'needs review'}. First-attempt score is retained when you practice again.</p>}
    <SourceLinks ids={question.sources}/>
    <div className="academy-lesson-nav"><button disabled={position === 0} onClick={onPrevious}><ChevronLeft size={16}/> Previous</button><span>{position + 1} / {count}</span><button onClick={onNext}>{position === count - 1 ? 'Finish this set' : 'Next lesson'} <ChevronRight size={16}/></button></div>
  </article>;
}
function AcademyWorkspace({ storageKey }: {
    storageKey: string;
}) {
    const [progress, setProgress] = useState<Progress>(() => { try {
        return parseProgress(localStorage.getItem(storageKey), questions);
    }
    catch {
        return emptyProgress();
    } });
    const [saved, setSaved] = useState(true);
    const [tab, setTab] = useState<Tab>('overview');
    const [queue, setQueue] = useState(allIds);
    const [index, setIndex] = useState(0);
    const [search, setSearch] = useState('');
    const [notice, setNotice] = useState('');
    const stats = progressStats(progress, questions);
    const current = questions.find(q => q.id === queue[index]) || questions[0];
    const currentModule = modules.find(module => module.questions.some(q => q.id === current.id));
    useEffect(() => { try {
        localStorage.setItem(storageKey, JSON.stringify(progress));
        setSaved(true);
    }
    catch {
        setSaved(false);
    } }, [progress, storageKey]);
    useEffect(() => { const previous = document.title; document.title = 'Commercial Academy | HomeNode'; return () => { document.title = previous; }; }, []);
    function start(ids: string[], resume = false) {
        if (!ids.length) {
            setNotice('Nothing in this review set yet. Complete a lesson or save a question first.');
            return;
        }
        setQueue(ids);
        setIndex(resume && progress.lastId && ids.includes(progress.lastId) ? ids.indexOf(progress.lastId) : 0);
        setTab('learn');
        setNotice('');
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    function navigate(next: number) {
        if (next >= queue.length) {
            setNotice('Practice set finished. Your dashboard shows answered questions and anything still needing review.');
            setTab('overview');
            return;
        }
        setIndex(next);
        setProgress(p => ({ ...p, lastId: queue[next] }));
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    const filteredModules = modules.filter(module => `${module.title} ${module.subtitle} ${module.questions.map(q => q.title).join(' ')}`.toLowerCase().includes(search.toLowerCase()));
    return <div className="academy-shell">
    <header className="academy-header"><Link to="/" className="academy-brand"><img src="/branding/homenode-logo.png" alt="HomeNode"/><span>COMMERCIAL ACADEMY</span></Link><Link to="/" className="academy-back">← Back to workspace</Link></header>
    <nav className="academy-tabs" aria-label="Academy sections">{([['overview', 'Course overview'], ['learn', 'Lessons & practice'], ['lab', 'Model lab'], ['interview', 'Interview desk'], ['sources', 'Sources']] as [
        Tab,
        string
    ][]).map(([id, label]) => <button key={id} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}>{label}</button>)}</nav>
    <main className="academy-main">
      {notice && <div className="academy-notice" role="status">{notice}<button aria-label="Dismiss notice" onClick={() => setNotice('')}>×</button></div>}
      {tab === 'overview' && <>
        <section className="academy-hero"><div><span className="academy-kicker">FROM PROPERTY FACTS TO A DEFENSIBLE VALUE</span><h1>Think like a<br />commercial appraiser.</h1><p>Read the concept. Work the case. Explain the conclusion. A focused course in multifamily, industrial and office valuation.</p><div className="academy-actions"><button className="academy-primary" onClick={() => start(questions.filter(q => q.essential).map(q => q.id))}>Start 60-minute review <ArrowRight size={18}/></button><button onClick={() => start(allIds, true)}>{stats.answered ? 'Continue full course' : 'Explore full course'}</button></div><span className="academy-hero-note">10 modules · 50 case questions · 2 model labs</span></div><div className="academy-hero-art" aria-hidden="true"><div className="academy-art-grid"/><div className="academy-building b1"/><div className="academy-building b2"/><div className="academy-building b3"/><div className="academy-art-label"><span>INCOME → VALUE</span><strong>V = NOI / R</strong><small>Evidence before precision.</small></div></div></section>
        <section className="academy-stats" aria-label="Your progress"><div><small>Completed</small><strong>{stats.answered}<span> / {questions.length}</span></strong><progress max={questions.length} value={stats.answered} aria-label="Course completion"/></div><div><small>First-attempt accuracy</small><strong>{stats.answered ? Math.round(stats.firstCorrect / stats.answered * 100) + '%' : '—'}</strong><span>{stats.firstCorrect} correct of {stats.answered} answered</span></div><div><small>Needs review</small><strong>{stats.missed.length}</strong><button disabled={!stats.missed.length} onClick={() => start(stats.missed)}>Practice missed questions →</button></div><div><small>Saved questions</small><strong>{progress.bookmarks.length}</strong><button disabled={!progress.bookmarks.length} onClick={() => start(progress.bookmarks)}>Open saved set →</button></div></section>
        <div className="academy-section-heading"><div><span className="academy-kicker">THE LEARNING PATH</span><h2>Build from the fundamentals.</h2></div><label className="academy-search"><span className="academy-sr-only">Find a topic</span><input placeholder="Find a topic…" value={search} onChange={e => setSearch(e.target.value)}/></label></div>
        <div className="academy-module-grid">{filteredModules.map(module => { const s = progressStats(progress, module.questions); return <button className="academy-module-card" key={module.id} onClick={() => start(module.questions.map(q => q.id))}><span className="academy-module-top"><span>{String(modules.indexOf(module) + 1).padStart(2, '0')}</span><small>{module.minutes} min</small></span><h3>{module.title}</h3><p>{module.subtitle}</p><div><span>{s.answered}/{module.questions.length} answered</span><ArrowRight size={18}/></div><progress max={module.questions.length} value={s.answered} aria-label={`${module.title} progress`}/></button>; })}</div>
        {!filteredModules.length && <p>No matching topics. Try “lease,” “DCF,” “market” or “AI.”</p>}
        <div className="academy-study-plan"><GraduationCap size={28}/><div><h3>For tomorrow’s interview</h3><p>Spend about 60 minutes on the core review, 20 minutes changing assumptions in the model lab, then 15 minutes explaining the interview prompts aloud. The complete course takes roughly four hours before additional practice.</p></div></div>
      </>}
      {tab === 'learn' && <div className="academy-learning-layout"><aside className="academy-outline"><span className="academy-kicker">COURSE CONTENTS</span>{modules.map((module, i) => <button key={module.id} aria-current={currentModule?.id === module.id ? 'step' : undefined} onClick={() => start(module.questions.map(q => q.id))}><span>{String(i + 1).padStart(2, '0')}</span><span>{module.title}<small>{progressStats(progress, module.questions).answered}/{module.questions.length} answered</small></span></button>)}<button onClick={() => start(stats.missed)} disabled={!stats.missed.length}><RotateCcw size={16}/> Review missed</button></aside><Lesson key={`${current.id}:${queue.join(',')}`} question={current} progress={progress} position={index} count={queue.length} onAnswer={choice => setProgress(p => recordAnswer(p, current, choice))} onBookmark={() => setProgress(p => ({ ...p, bookmarks: p.bookmarks.includes(current.id) ? p.bookmarks.filter(id => id !== current.id) : [...p.bookmarks, current.id] }))} onPrevious={() => navigate(index - 1)} onNext={() => navigate(index + 1)}/></div>}
      {tab === 'lab' && <ModelLab />}
      {tab === 'interview' && <section className="academy-interview"><span className="academy-kicker">TURN KNOWLEDGE INTO A CLEAR ANSWER</span><h1>The interview desk</h1><p>Practice a 60–90 second answer before opening each guide. Use actual experience when discussing your background.</p><div className="academy-company"><h2>BBG context</h2><p>BBG’s Dallas office describes valuation work across multifamily, office, industrial and other asset types, including complex and portfolio assignments. Use that context to ask about the specific team and role. These are original practice prompts, not BBG interview questions or an endorsed training program.</p><SourceLinks ids={['bbg']}/></div>{interviewPrompts.map((prompt, i) => <details className="academy-interview-prompt" key={prompt.title}><summary><span>{String(i + 1).padStart(2, '0')}</span>{prompt.title}</summary><p>{prompt.answer}</p></details>)}<h2>A compact formula sheet</h2><div className="academy-formula-sheet">{[['Direct capitalization', 'V = NOI / cap rate'], ['Effective gross income', 'Potential rent − non-overlapping losses + other income'], ['Property cash flow', 'NOI − capital and leasing costs (if not already deducted)'], ['Present value', 'CFₜ / (1 + discount rate)ᵗ'], ['Net reversion', 'Forward NOI / exit cap × (1 − selling-cost fraction)'], ['Band of investment', 'LTV × mortgage constant + equity share × equity dividend rate'], ['Debt service coverage', 'NOI / annual debt service'], ['Debt yield', 'NOI / loan amount']].map(([label, formula]) => <div key={label}><strong>{label}</strong><span>{formula}</span></div>)}</div><button onClick={() => window.print()}>Print interview review</button></section>}
      {tab === 'sources' && <section className="academy-sources"><span className="academy-kicker">READ THE UNDERLYING GUIDANCE</span><h1>Sources & assumptions</h1><p>Original educational explanations, questions and hypothetical cases, reviewed against the primary references below on {courseVersion}. This is interview practice, not a credentialing or approved continuing-education course. Case rents, cap rates, discount rates and forecasts are invented for calculation practice.</p><p>The references explain methods and professional considerations. They do not establish the current market value or market rates of a real Dallas property. Re-check applicable standards and effective-date market evidence for a real assignment.</p>{Object.entries(sources).map(([id, source]) => <article key={id}><h3><a href={source.url} target="_blank" rel="noreferrer">{source.title} ↗</a></h3><p>{source.note}</p></article>)}</section>}
    </main>
    <footer className="academy-footer"><span>HomeNode Commercial Academy · {saved ? 'Progress saved in this browser for this account' : 'Browser storage unavailable; progress lasts only for this visit'}. No cross-device sync.</span><button onClick={() => { if (window.confirm('Reset only your Commercial Academy answers and saved questions in this browser?')) {
        setProgress(emptyProgress());
        setNotice('Course progress reset.');
    } }}>Reset course progress</button></footer>
  </div>;
}
export default function CommercialAcademy() {
    const { session } = useApplicationAuth();
    const key = `homenode:commercial-academy:v1:${session?.user_id || 'local'}`;
    return <AcademyWorkspace key={key} storageKey={key}/>;
}
