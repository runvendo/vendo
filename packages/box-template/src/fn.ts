/**
 * Call one of this app's own fns: `await callFn("listInvoices", { limit: 10 })`.
 *
 * The app's own server half (../fns.js) is the only thing holding the app's
 * token, so the page reaches its data THROUGH it — never by holding a credential
 * itself. Relative on purpose: a shared app is served under `/apps/<id>/serve/`,
 * so `fn/<name>` resolves inside the mount and `/fn/<name>` would not.
 */
export async function callFn<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(`fn/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ args }),
  });
  const body = await response.json() as { result?: T; error?: { code: string; message: string } };
  if (body.error) throw new Error(`${body.error.code}: ${body.error.message}`);
  return body.result as T;
}
