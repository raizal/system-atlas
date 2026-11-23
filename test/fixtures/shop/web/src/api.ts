export async function loadOrders(): Promise<string[]> {
  const res = await fetch('/api/orders');
  return (await res.json()) as string[];
}

export async function saveOrder(name: string): Promise<void> {
  await fetch('/api/orders', { method: 'POST', body: JSON.stringify({ name }) });
}
