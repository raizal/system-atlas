export async function loadNotes(): Promise<string[]> {
  const res = await fetch('/api/notes');
  return (await res.json()) as string[];
}
