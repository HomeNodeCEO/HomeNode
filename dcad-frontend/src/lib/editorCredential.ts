let editorCredential = '';
let applicationSessionActive = false;

export const AUTHENTICATED_SESSION_EDITOR_CREDENTIAL = '__homenode_authenticated_session__';

export function setApplicationSessionActive(active: boolean): void {
  applicationSessionActive = active === true;
}

export function isAuthenticatedSessionEditorCredential(value: unknown): boolean {
  return String(value ?? '') === AUTHENTICATED_SESSION_EDITOR_CREDENTIAL;
}

export function editorCredentialForRequest(value?: unknown): string {
  if (applicationSessionActive) return AUTHENTICATED_SESSION_EDITOR_CREDENTIAL;
  return String(value ?? editorCredential).trim();
}

export function readEditorCredential(): string {
  return editorCredential;
}

export function rememberEditorCredential(value: unknown): string {
  const normalized = String(value ?? '').trim();
  if (normalized !== AUTHENTICATED_SESSION_EDITOR_CREDENTIAL) {
    editorCredential = normalized;
  }
  return editorCredential;
}

export function forgetEditorCredential(): void {
  editorCredential = '';
}

export function requestEditorCredential(message: string): string {
  const available = editorCredentialForRequest();
  if (available) return available;
  if (typeof window === 'undefined') return '';
  return rememberEditorCredential(window.prompt(message, '') || '');
}
