export type Source = {
    title: string;
    url: string;
    note: string;
};
export type Question = {
    id: string;
    title: string;
    caseId: 'mf' | 'industrial' | 'office' | 'mixed';
    lesson: string[];
    formula?: string;
    prompt: string;
    options: string[];
    answer: number;
    explanations: string[];
    takeaway: string;
    sources: string[];
    essential?: boolean;
};
export type CourseModule = {
    id: string;
    title: string;
    subtitle: string;
    minutes: number;
    questions: Question[];
};
export type AnswerRecord = {
    selected: number;
    first: number;
    attempts: number;
};
export type Progress = {
    version: 1;
    answers: Record<string, AnswerRecord>;
    bookmarks: string[];
    lastId?: string;
    readModules?: string[];
    lastModuleId?: string;
};
export type KnowledgeCheck = {
    prompt: string;
    options: string[];
    answer: number;
    explanation: string;
};
export type ReadingSection = {
    id: string;
    title: string;
    paragraphs: string[];
    formula?: string;
    example?: { title: string; columns: string[]; rows: string[][]; explanation: string };
    check?: KnowledgeCheck;
};
export type ModuleReading = {
    moduleId: string;
    introduction: string;
    objectives: string[];
    sections: ReadingSection[];
    summary: string[];
};
