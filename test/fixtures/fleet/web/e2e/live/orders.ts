// A live e2e helper: test code, not an HTTP client of the app.
export async function seedOrder(): Promise<void> {
  await fetch('/api/core-proxy/v1/orders', { method: 'GET' });
}
