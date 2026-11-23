import { useEffect, useState } from 'react';
import { loadNotes } from './api';

export function App() {
  const [notes, setNotes] = useState<string[]>([]);
  useEffect(() => {
    void loadNotes().then(setNotes);
  }, []);
  return (
    <ul data-testid="notes">
      {notes.map((n) => (
        <li key={n}>{n}</li>
      ))}
    </ul>
  );
}
