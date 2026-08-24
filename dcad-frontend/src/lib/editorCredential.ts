let editorCredential = '';

export function readEditorCredential(): string {
  return editorCredential;
}

export function rememberEditorCredential(value: unknown): string {
  editorCredential = String(value ?? '').trim();
  return editorCredential;
}

export function forgetEditorCredential(): void {
  editorCredential = '';
}

export function requestEditorCredential(message: string): string {
  if (editorCredential) return editorCredential;
  if (typeof window === 'undefined') return '';
  return rememberEditorCredential(window.prompt(message, '') || '');
}
