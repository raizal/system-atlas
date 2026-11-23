export async function listAudits(): Promise<string[]> {
  const res = await fetch('/api/audits');
  return res.json();
}
