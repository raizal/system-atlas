const CORE_URL = process.env.CORE_URL;

export async function GET(): Promise<Response> {
  return fetch(`${CORE_URL}/v1/orders`);
}
