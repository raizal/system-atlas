import { useState } from 'react';

const API = '/api/core-proxy';

async function loadOrders(): Promise<string[]> {
  const res = await fetch(`${API}/v1/orders`);
  return res.json();
}

export default function OrdersPage() {
  const [items, setItems] = useState<string[]>([]);
  if (items.length === 0) void loadOrders().then(setItems);
  return <ul>{items.map((i) => <li key={i}>{i}</li>)}</ul>;
}
