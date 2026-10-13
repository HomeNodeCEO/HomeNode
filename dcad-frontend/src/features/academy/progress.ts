import type { Progress, Question } from './types';
export function emptyProgress(): Progress { return { version: 1, answers: {}, bookmarks: [] }; }
export function parseProgress(raw: string | null, questions: Question[]): Progress {
    if (!raw)
        return emptyProgress();
    try {
        const value = JSON.parse(raw);
        if (!value || value.version !== 1 || typeof value.answers !== 'object' || !value.answers)
            return emptyProgress();
        const clean = emptyProgress();
        for (const question of questions) {
            const record = value.answers[question.id];
            const validOption = (n: unknown) => Number.isInteger(n) && Number(n) >= 0 && Number(n) < question.options.length;
            if (record && validOption(record.selected) && validOption(record.first) && Number.isSafeInteger(record.attempts) && record.attempts > 0)
                clean.answers[question.id] = { selected: record.selected, first: record.first, attempts: record.attempts };
        }
        clean.bookmarks = questions.filter(q => Array.isArray(value.bookmarks) && value.bookmarks.includes(q.id)).map(q => q.id);
        if (questions.some(q => q.id === value.lastId))
            clean.lastId = value.lastId;
        return clean;
    }
    catch {
        return emptyProgress();
    }
}
export function recordAnswer(progress: Progress, question: Question, selected: number): Progress {
    if (!Number.isInteger(selected) || selected < 0 || selected >= question.options.length)
        return progress;
    const prior = progress.answers[question.id];
    return { ...progress, lastId: question.id, answers: { ...progress.answers, [question.id]: { selected, first: prior?.first ?? selected, attempts: (prior?.attempts ?? 0) + 1 } } };
}
export function progressStats(progress: Progress, questions: Question[]) {
    const answered = questions.filter(q => progress.answers[q.id]);
    return { answered: answered.length, correct: answered.filter(q => progress.answers[q.id].selected === q.answer).length, firstCorrect: answered.filter(q => progress.answers[q.id].first === q.answer).length, missed: answered.filter(q => progress.answers[q.id].selected !== q.answer).map(q => q.id) };
}
