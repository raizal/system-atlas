export function StatusView({ count, onClose }: { count: number; onClose: () => void }) {
  return <p onClick={onClose}>{count} orders</p>;
}
