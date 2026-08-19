import { createTodo, listTodos } from "../../../lib/todos";

export const dynamic = "force-dynamic";

/** List the signed-in person's todos. */
export function GET(req: Request): Response {
  const url = new URL(req.url);
  const done = url.searchParams.get("done");
  return Response.json({
    todos: listTodos(done === null ? undefined : done === "true"),
  });
}

/** Add a todo to the list. */
export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "title is required" }, { status: 400 });
  }

  const input = typeof body === "object" && body !== null ? (body as { title?: unknown }) : {};
  if (typeof input.title !== "string" || input.title.length === 0) {
    return Response.json({ error: "title is required" }, { status: 400 });
  }

  return Response.json({ todo: createTodo(input.title) });
}
