const NOTES = ['buy milk', 'call home'];

export function noteTitles(): string[] {
  return NOTES.map((n) => n.toUpperCase());
}

export function listNotes(): string[] {
  return noteTitles();
}
