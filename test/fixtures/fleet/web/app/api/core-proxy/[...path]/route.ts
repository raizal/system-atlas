export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  return fetch(`http://core:8000${url.pathname.replace('/api/core-proxy', '')}`);
}
