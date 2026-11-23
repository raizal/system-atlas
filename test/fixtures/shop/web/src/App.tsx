import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadOrders, saveOrder } from './api'; import { StatusView } from './StatusView';

function Empty() {
  return <p>No orders</p>;
}

function OrderList({ items }: { items: string[] }) {
  return <ul>{items.map((i) => <li key={i}>{i}</li>)}</ul>;
}

function OrderForm({ onSave }: { onSave: (name: string) => void }) {
  return <button onClick={() => onSave('new')}>Save</button>;
}

export function App() {
  const [orders, setOrders] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    void loadOrders().then(setOrders);
  }, []);
  const box = useRef<HTMLDivElement>(null);
  const count = useMemo(() => orders.length, [orders]);
  const reset = useCallback(() => setOrders([]), []);
  const close = useCallback(() => setOpen(false), []);
  const Status = StatusView;
  return (
    <div ref={box}>
      {open && <OrderForm onSave={(n) => void saveOrder(n)} />}
      {orders.length === 0 ? <Empty /> : <OrderList items={orders} />}
      <button onClick={() => setOpen(true)}>New order</button>
      <button onClick={reset}>Reset</button>
      <Status count={count} onClose={close} />
    </div>
  );
}
