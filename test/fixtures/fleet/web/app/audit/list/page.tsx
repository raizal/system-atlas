import { useAudits } from '../../../hooks/useAudits';

export default function AuditListPage() {
  const audits = useAudits();
  return <ul>{audits.map((a) => <li key={a}>{a}</li>)}</ul>;
}
