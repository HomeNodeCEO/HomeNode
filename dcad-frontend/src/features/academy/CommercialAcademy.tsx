import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, GraduationCap, RotateCcw } from 'lucide-react';
import { useApplicationAuth } from '../auth/ApplicationAuth';
import { modules, questions, courseVersion } from './course';
import { readings } from './readings';
import { interviewPrompts, sources } from './reference';
import { emptyProgress, markModuleRead, parseProgress, progressStats, recordExam } from './progress';
import type { Progress } from './types';
import CourseReading, { SourceLinks } from './CourseReading';
import SectionExam from './SectionExam';
import ModelLab from './ModelLab';
import './academy.css';

type Tab = 'overview' | 'learn' | 'lab' | 'interview' | 'sources';
const moduleIds = modules.map(module => module.id);

function AcademyWorkspace({ storageKey }: { storageKey: string }) {
  const [progress, setProgress] = useState<Progress>(() => {
    try { return parseProgress(localStorage.getItem(storageKey), questions, moduleIds); }
    catch { return emptyProgress(); }
  });
  const [saved, setSaved] = useState(true);
  const [tab, setTab] = useState<Tab>('overview');
  const [activeModuleId, setActiveModuleId] = useState(() => progress.lastModuleId || modules.find(m => m.questions.some(q => q.id === progress.lastId))?.id || modules[0].id);
  const [mode, setMode] = useState<'reading' | 'exam'>('reading');
  const [examIds, setExamIds] = useState<string[]>([]);
  const [reviewTitle, setReviewTitle] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [notice, setNotice] = useState('');
  const [examSession, setExamSession] = useState(0);
  const stats = progressStats(progress, questions);
  const activeIndex = modules.findIndex(m => m.id === activeModuleId);
  const activeModule = modules[activeIndex];
  const activeReading = readings.find(r => r.moduleId === activeModuleId)!;
  const examQuestions = examIds.map(id => questions.find(q => q.id === id)!).filter(Boolean);
  const readModules = progress.readModules || [];

  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(progress)); setSaved(true); }
    catch { setSaved(false); }
  }, [progress, storageKey]);
  useEffect(() => { const previous = document.title; document.title = 'Commercial Academy | HomeNode'; return () => { document.title = previous; }; }, []);

  function openModule(id: string) {
    setActiveModuleId(id); setMode('reading'); setReviewTitle(null); setTab('learn'); setNotice('');
    setProgress(p => ({ ...p, lastModuleId: id }));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function startExam() {
    setProgress(p => markModuleRead(p, activeModuleId));
    setExamIds(activeModule.questions.map(q => q.id)); setReviewTitle(null); setMode('exam'); setExamSession(s => s + 1);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function startReview(ids: string[], title: string) {
    if (!ids.length) return;
    setExamIds(ids); setReviewTitle(title); setMode('exam'); setTab('learn'); setExamSession(s => s + 1);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function toggleBookmark(id: string) {
    setProgress(p => ({ ...p, bookmarks: p.bookmarks.includes(id) ? p.bookmarks.filter(item => item !== id) : [...p.bookmarks, id] }));
  }
  function finishExam() {
    if (!reviewTitle && activeIndex < modules.length - 1) openModule(modules[activeIndex + 1].id);
    else { setTab('overview'); setNotice('Review complete. Your dashboard shows reading progress, exam answers and topics to revisit.'); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  }
  const filteredModules = modules.filter(module => {
    const reading = readings.find(r => r.moduleId === module.id)!;
    return [module.title, module.subtitle, ...reading.sections.map(s => s.title), ...module.questions.map(q => q.title)].join(' ').toLowerCase().includes(search.toLowerCase());
  });
  return <div className="academy-shell">
    <header className="academy-header"><Link to="/" className="academy-brand"><img src="/branding/homenode-logo.png" alt="HomeNode"/><span>COMMERCIAL ACADEMY</span></Link><Link to="/" className="academy-back">← Back to workspace</Link></header>
    <nav className="academy-tabs" aria-label="Academy sections">{([['overview', 'Course overview'], ['learn', 'Lessons & exams'], ['lab', 'Model lab'], ['interview', 'Interview desk'], ['sources', 'Sources']] as [Tab, string][]).map(([id, label]) => <button key={id} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}>{label}</button>)}</nav>
    <main className="academy-main">
      {notice && <div className="academy-notice" role="status">{notice}<button aria-label="Dismiss notice" onClick={() => setNotice('')}>×</button></div>}
      {tab === 'overview' && <>
        <section className="academy-hero"><div><span className="academy-kicker">READ. WORK THE MATH. EXPLAIN THE VALUE.</span><h1>Think like a<br/>commercial appraiser.</h1><p>Detailed chapters, worked calculations and practical processes for multifamily, industrial and office valuation. Build your understanding, then test it.</p><div className="academy-actions"><button className="academy-primary" onClick={() => openModule(activeModuleId)}>{progress.lastModuleId ? 'Continue reading' : 'Start the course'} <ArrowRight size={18}/></button><button onClick={() => setTab('lab')}>Explore the model lab</button></div><span className="academy-hero-note">10 chapters · 20 knowledge checks · 10 section exams</span></div><div className="academy-hero-art" aria-hidden="true"><div className="academy-art-grid"/><div className="academy-building b1"/><div className="academy-building b2"/><div className="academy-building b3"/><div className="academy-art-label"><span>INCOME → VALUE</span><strong>V = NOI / R</strong><small>Understand every step.</small></div></div></section>
        <div className="academy-reading-progress"><BookProgress count={readModules.length}/><span>Each chapter ends with a five-question exam. Knowledge checks are ungraded.</span></div>
        <section className="academy-stats" aria-label="Your progress"><div><small>Exam questions answered</small><strong>{stats.answered}<span> / {questions.length}</span></strong><progress max={questions.length} value={stats.answered} aria-label="Exam completion"/></div><div><small>First-attempt accuracy</small><strong>{stats.answered ? Math.round(stats.firstCorrect / stats.answered * 100) + '%' : '—'}</strong><span>{stats.firstCorrect} correct of {stats.answered} answered</span></div><div><small>Needs review</small><strong>{stats.missed.length}</strong><button disabled={!stats.missed.length} onClick={() => startReview(stats.missed, 'Review missed questions')}>Practice missed questions →</button></div><div><small>Saved questions</small><strong>{progress.bookmarks.length}</strong><button disabled={!progress.bookmarks.length} onClick={() => startReview(progress.bookmarks, 'Saved questions')}>Open saved set →</button></div></section>
        <div className="academy-section-heading"><div><span className="academy-kicker">THE LEARNING PATH</span><h2>Learn the process, step by step.</h2></div><label className="academy-search"><span className="academy-sr-only">Find a topic</span><input placeholder="Find a topic…" value={search} onChange={e => setSearch(e.target.value)}/></label></div>
        <div className="academy-module-grid">{filteredModules.map(module => { const s = progressStats(progress, module.questions); return <button className="academy-module-card" key={module.id} onClick={() => openModule(module.id)}><span className="academy-module-top"><span>{String(modules.indexOf(module) + 1).padStart(2, '0')}</span><small>Reading + practice</small></span><h3>{module.title}</h3><p>{module.subtitle}</p><small>{readModules.includes(module.id) ? 'Reading complete' : '4 lesson sections · 2 knowledge checks'}</small><div><span>Exam: {s.answered}/{module.questions.length} answered</span><ArrowRight size={18}/></div><progress max={module.questions.length} value={s.answered} aria-label={module.title + ' exam progress'}/></button>; })}</div>
        {!filteredModules.length && <p>No matching topics. Try “lease,” “DCF,” “market” or “AI.”</p>}
        <div className="academy-study-plan"><GraduationCap size={28}/><div><h3>A useful study rhythm</h3><p>Read one chapter with a calculator nearby. Rework its examples, pause at the knowledge checks, then take its exam. Use the model lab to change assumptions and the interview desk to practice explaining your reasoning aloud.</p><button onClick={() => startReview(questions.filter(q => q.essential).map(q => q.id), 'Core concepts review')}>Quick review: 24 core questions</button></div></div>
      </>}
      {tab === 'learn' && <div className="academy-learning-layout"><aside className="academy-outline"><span className="academy-kicker">COURSE CONTENTS</span>{modules.map((module, i) => <button key={module.id} aria-current={!reviewTitle && activeModuleId === module.id ? 'step' : undefined} onClick={() => openModule(module.id)}><span>{String(i + 1).padStart(2, '0')}</span><span>{module.title}<small>{readModules.includes(module.id) ? 'Read' : 'Chapter'} · Exam {progressStats(progress, module.questions).answered}/5</small></span></button>)}<button onClick={() => startReview(stats.missed, 'Review missed questions')} disabled={!stats.missed.length}><RotateCcw size={16}/> Review missed</button></aside>{mode === 'reading' ? <CourseReading key={activeModule.id} module={activeModule} reading={activeReading} position={activeIndex} isRead={readModules.includes(activeModule.id)} onRead={() => setProgress(p => markModuleRead(p, activeModule.id))} onExam={startExam}/> : <SectionExam key={examSession} title={reviewTitle || activeModule.title} questions={examQuestions} progress={progress} onSubmit={answers => setProgress(p => recordExam(p, examQuestions, answers))} onBookmark={toggleBookmark} onReading={() => openModule(activeModuleId)} onFinish={finishExam} finishLabel={!reviewTitle && activeIndex < modules.length - 1 ? 'Next chapter' : 'Return to overview'}/>}</div>}
      {tab === 'lab' && <ModelLab />}
      {tab === 'interview' && <section className="academy-interview"><span className="academy-kicker">TURN KNOWLEDGE INTO A CLEAR ANSWER</span><h1>The interview desk</h1><p>Practice a 60–90 second answer before opening each guide. Use actual experience when discussing your background.</p><div className="academy-company"><h2>BBG context</h2><p>BBG’s Dallas office describes valuation work across multifamily, office, industrial and other asset types, including complex and portfolio assignments. Use that context to ask about the specific team and role. These are original practice prompts, not BBG interview questions or an endorsed training program.</p><SourceLinks ids={['bbg']}/></div>{interviewPrompts.map((prompt, i) => <details className="academy-interview-prompt" key={prompt.title}><summary><span>{String(i + 1).padStart(2, '0')}</span>{prompt.title}</summary><p>{prompt.answer}</p></details>)}<h2>A compact formula sheet</h2><div className="academy-formula-sheet">{[['Direct capitalization', 'V = NOI / cap rate'], ['Effective gross income', 'Potential rent − non-overlapping losses + other income'], ['Property cash flow', 'NOI − capital and leasing costs (if not already deducted)'], ['Present value', 'CFₜ / (1 + discount rate)ᵗ'], ['Net reversion', 'Forward NOI / exit cap × (1 − selling-cost fraction)'], ['Band of investment', 'LTV × mortgage constant + equity share × equity dividend rate'], ['Debt service coverage', 'NOI / annual debt service'], ['Debt yield', 'NOI / loan amount']].map(([label, formula]) => <div key={label}><strong>{label}</strong><span>{formula}</span></div>)}</div><button onClick={() => window.print()}>Print interview review</button></section>}
      {tab === 'sources' && <section className="academy-sources"><span className="academy-kicker">READ THE UNDERLYING GUIDANCE</span><h1>Sources & assumptions</h1><p>Original educational explanations, questions and hypothetical cases, reviewed against the primary references below on {courseVersion}. This is interview practice, not a credentialing or approved continuing-education course. Case rents, cap rates, discount rates and forecasts are invented for calculation practice.</p><p>The references explain methods and professional considerations. They do not establish the current market value or market rates of a real Dallas property. Re-check applicable standards and effective-date market evidence for a real assignment.</p>{Object.entries(sources).map(([id, source]) => <article key={id}><h3><a href={source.url} target="_blank" rel="noreferrer">{source.title} ↗</a></h3><p>{source.note}</p></article>)}</section>}
    </main>
    <footer className="academy-footer"><span>HomeNode Commercial Academy · {saved ? 'Progress saved in this browser for this account' : 'Browser storage unavailable; progress lasts only for this visit'}. No cross-device sync.</span><button onClick={() => { if (window.confirm('Reset your Commercial Academy reading progress, exam answers and saved questions in this browser?')) { setProgress(emptyProgress()); setTab('overview'); setMode('reading'); setActiveModuleId(modules[0].id); setNotice('Course progress reset.'); } }}>Reset course progress</button></footer>
  </div>;
}
function BookProgress({ count }: { count: number }) { return <strong>{count} / {modules.length} chapters read</strong>; }
export default function CommercialAcademy() {
  const { session } = useApplicationAuth();
  const key = 'homenode:commercial-academy:v1:' + (session?.user_id || 'local');
  return <AcademyWorkspace key={key} storageKey={key}/>;
}
