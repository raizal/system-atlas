import { useState } from 'react';
import { listAudits } from '../services/audits';

export function useAudits(): string[] {
  const [items, setItems] = useState<string[]>([]);
  if (items.length === 0) void listAudits().then(setItems);
  return items;
}
