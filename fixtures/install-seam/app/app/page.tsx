import { listTodos } from "../lib/todos";

export const dynamic = "force-dynamic";

export default function Home() {
  return (
    <main>
      <h1>Todos</h1>
      <ul>
        {listTodos().map((todo) => (
          <li key={todo.id}>{todo.title}</li>
        ))}
      </ul>
    </main>
  );
}
