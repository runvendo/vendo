export type TaskStatus = "open" | "in-progress" | "done";
export type TaskPriority = "low" | "medium" | "high";

export interface TeamMember {
  id: string;
  name: string;
  initials: string;
}

export interface RelayTask {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignee: TeamMember;
  team: { id: string; name: string };
  dueDate: string;
}

const ADA: TeamMember = { id: "member-ada", name: "Ada Chen", initials: "AC" };
const MARCUS: TeamMember = { id: "member-marcus", name: "Marcus Reed", initials: "MR" };
const PRIYA: TeamMember = { id: "member-priya", name: "Priya Shah", initials: "PS" };
const TEAM = { id: "team-relay", name: "Relay product" };

export const SEEDED_TASKS: readonly RelayTask[] = [
  { id: "task-101", title: "Polish onboarding checklist", description: "Trim the first-run checklist to the five essential steps.", status: "in-progress", priority: "high", assignee: ADA, team: TEAM, dueDate: "2026-07-14" },
  { id: "task-102", title: "Review mobile empty states", description: "Check copy and actions on every empty list.", status: "open", priority: "medium", assignee: PRIYA, team: TEAM, dueDate: "2026-07-16" },
  { id: "task-103", title: "Ship weekly digest", description: "Finish the Friday email summary and preference toggle.", status: "open", priority: "high", assignee: MARCUS, team: TEAM, dueDate: "2026-07-17" },
  { id: "task-104", title: "Archive stale projects", description: "Confirm retention rules with support before cleanup.", status: "done", priority: "low", assignee: ADA, team: TEAM, dueDate: "2026-07-10" },
  { id: "task-105", title: "Instrument task completion", description: "Add the completion funnel to the product dashboard.", status: "in-progress", priority: "medium", assignee: MARCUS, team: TEAM, dueDate: "2026-07-15" },
  { id: "task-106", title: "Prepare customer council notes", description: "Group feedback into workflow, speed, and collaboration themes.", status: "open", priority: "medium", assignee: PRIYA, team: TEAM, dueDate: "2026-07-18" },
  { id: "task-107", title: "Refresh keyboard shortcuts", description: "Bring the help modal in sync with the current command set.", status: "done", priority: "low", assignee: MARCUS, team: TEAM, dueDate: "2026-07-09" },
  { id: "task-108", title: "Plan Q3 reliability work", description: "Rank the top failure modes and assign first owners.", status: "open", priority: "high", assignee: ADA, team: TEAM, dueDate: "2026-07-21" },
];

export interface CreateTaskInput {
  title: string;
  description?: string;
  assignee?: TeamMember;
  priority?: TaskPriority;
  dueDate?: string;
}

export class TaskStore {
  readonly #tasks = new Map<string, RelayTask>();
  #nextId = 109;
  deleteCalls = 0;

  constructor(seed: readonly RelayTask[] = SEEDED_TASKS) {
    for (const task of seed) this.#tasks.set(task.id, structuredClone(task));
  }

  list(status?: TaskStatus): RelayTask[] {
    return [...this.#tasks.values()]
      .filter((task) => status === undefined || task.status === status)
      .map((task) => structuredClone(task));
  }

  get(id: string): RelayTask | undefined {
    const task = this.#tasks.get(id);
    return task === undefined ? undefined : structuredClone(task);
  }

  create(input: CreateTaskInput): RelayTask {
    const task: RelayTask = {
      id: `task-${this.#nextId++}`,
      title: input.title,
      description: input.description ?? "",
      status: "open",
      priority: input.priority ?? "medium",
      assignee: structuredClone(input.assignee ?? ADA),
      team: structuredClone(TEAM),
      dueDate: input.dueDate ?? "2026-07-25",
    };
    this.#tasks.set(task.id, task);
    return structuredClone(task);
  }

  complete(id: string): RelayTask | undefined {
    const task = this.#tasks.get(id);
    if (task === undefined) return undefined;
    task.status = "done";
    return structuredClone(task);
  }

  delete(id: string): boolean {
    this.deleteCalls += 1;
    return this.#tasks.delete(id);
  }
}
