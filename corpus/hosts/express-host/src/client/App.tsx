import { useEffect, useMemo, useState } from "react";

type TaskStatus = "open" | "in-progress" | "done";

interface RelayTask {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: "low" | "medium" | "high";
  assignee: { id: string; name: string; initials: string };
  team: { id: string; name: string };
  dueDate: string;
}

const FILTERS: Array<{ label: string; value: "all" | TaskStatus }> = [
  { label: "All tasks", value: "all" },
  { label: "Open", value: "open" },
  { label: "In progress", value: "in-progress" },
  { label: "Done", value: "done" },
];

export function App() {
  const [tasks, setTasks] = useState<RelayTask[]>([]);
  const [filter, setFilter] = useState<"all" | TaskStatus>("all");
  const [error, setError] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/tasks", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Tasks request failed (${response.status})`);
        return response.json() as Promise<RelayTask[]>;
      })
      .then(setTasks)
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Tasks request failed");
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const openAssistant = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        document.querySelector<HTMLButtonElement>("#relay-vendo-layer .fl-launcher")?.click();
      }
    };
    document.addEventListener("keydown", openAssistant);
    return () => document.removeEventListener("keydown", openAssistant);
  }, []);

  const visibleTasks = useMemo(
    () => tasks.filter((task) => filter === "all" || task.status === filter),
    [filter, tasks],
  );
  const completed = tasks.filter((task) => task.status === "done").length;

  const openVendo = () => {
    document.querySelector<HTMLButtonElement>("#relay-vendo-layer .fl-launcher")?.click();
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Relay home">
          <span className="brand-mark" aria-hidden="true">R</span>
          <span>Relay</span>
        </a>
        <button className="ask-relay" type="button" onClick={openVendo}>
          <span aria-hidden="true">✦</span> Ask Relay
          <kbd>⌘K</kbd>
        </button>
      </header>

      <main>
        <section className="hero" aria-labelledby="task-heading">
          <div>
            <p className="eyebrow">Relay product · This week</p>
            <h1 id="task-heading">Keep the team moving.</h1>
            <p className="hero-copy">A small, clear view of what needs attention and who is carrying it forward.</p>
          </div>
          <div className="progress-card" aria-label={`${completed} of ${tasks.length} tasks complete`}>
            <strong>{completed}/{tasks.length || 8}</strong>
            <span>tasks complete</span>
            <div className="progress-track"><span style={{ width: `${tasks.length === 0 ? 0 : completed / tasks.length * 100}%` }} /></div>
          </div>
        </section>

        <section className="task-panel" aria-label="Team tasks">
          <div className="panel-toolbar">
            <div className="filters" aria-label="Filter tasks">
              {FILTERS.map(({ label, value }) => (
                <button
                  className={filter === value ? "active" : undefined}
                  type="button"
                  aria-pressed={filter === value}
                  onClick={() => setFilter(value)}
                  key={value}
                >
                  {label}
                </button>
              ))}
            </div>
            <span className="task-count">{visibleTasks.length} shown</span>
          </div>

          {error ? <p className="error" role="alert">{error}</p> : null}
          <div className="task-list">
            {visibleTasks.map((task) => (
              <article className="task-row" key={task.id}>
                <span className={`status-dot status-${task.status}`} aria-label={task.status} />
                <div className="task-copy">
                  <div className="task-title-line">
                    <h2>{task.title}</h2>
                    <span className={`priority priority-${task.priority}`}>{task.priority}</span>
                  </div>
                  <p>{task.description}</p>
                  <div className="task-meta">
                    <span className="avatar" title={task.assignee.name}>{task.assignee.initials}</span>
                    <span>{task.assignee.name}</span>
                    <span aria-hidden="true">·</span>
                    <time dateTime={task.dueDate}>Due {new Date(`${task.dueDate}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</time>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
