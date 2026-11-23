import { createServer } from 'node:http';

const orders: string[] = [];

function listOrders(): string {
  return JSON.stringify(orders);
}

function createOrder(name: string): string {
  if (name === '') throw new Error('The name is empty.');
  orders.push(name);
  return name;
}

export function handle(method: string, path: string, body: string): string {
  if (method === 'GET' && path === '/api/orders') return listOrders();
  if (method === 'POST' && path === '/api/orders') return createOrder(body);
  return 'not found';
}

export function start(): void {
  createServer((req, res) => res.end(handle(req.method ?? 'GET', req.url ?? '/', ''))).listen(8080);
}
