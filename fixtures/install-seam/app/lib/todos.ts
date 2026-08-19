/** The stranger app's entire domain: a todo list in memory. Seeded at module
 *  load so a fresh dev server always answers the same three rows, which is what
 *  the install-seam assertions read back through the agent. */

export interface Todo {
  id: string;
  title: string;
  done: boolean;
}

const todos: Todo[] = [
  { id: "todo_1", title: "Renew the passport", done: false },
  { id: "todo_2", title: "Book the dentist", done: false },
  { id: "todo_3", title: "Water the fig tree", done: true },
];

export function listTodos(done?: boolean): Todo[] {
  return done === undefined ? [...todos] : todos.filter((todo) => todo.done === done);
}

export function createTodo(title: string): Todo {
  const todo: Todo = { id: `todo_${todos.length + 1}`, title, done: false };
  todos.push(todo);
  return todo;
}
