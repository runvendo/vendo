import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { LanguageModel } from "ai";
import type { VendoStore } from "@vendoai/vendo";
import { serveFetchHandler } from "./fetch-adapter.js";
import { TaskStore, type TaskPriority, type TaskStatus, type TeamMember } from "./tasks.js";
import { createRelayVendo } from "./vendo.js";

const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CLIENT_DIST = resolve(PACKAGE_ROOT, "dist/client");
const TASK_STATUSES = new Set<TaskStatus>(["open", "in-progress", "done"]);
const TASK_PRIORITIES = new Set<TaskPriority>(["low", "medium", "high"]);

export interface RelayServerOptions {
  model?: LanguageModel;
  store?: VendoStore;
  tasks?: TaskStore;
}

export interface RelayServer {
  app: Express;
  tasks: TaskStore;
  vendo: ReturnType<typeof createRelayVendo>;
}

function notFound(res: Response, id: string): void {
  res.status(404).json({ error: { code: "not-found", message: `Task not found: ${id}` } });
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function createRelayServer(options: RelayServerOptions = {}): RelayServer {
  const app = express();
  const tasks = options.tasks ?? new TaskStore();
  const vendo = createRelayVendo({
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.store === undefined ? {} : { store: options.store }),
  });

  app.disable("x-powered-by");
  app.use("/api/vendo", (req, res, next) => {
    void serveFetchHandler(req, res, vendo.handler).catch((error: unknown) => {
      if (res.headersSent) res.destroy(error instanceof Error ? error : undefined);
      else next(error);
    });
  });

  const api = express.Router();
  api.use(express.json());
  api.get("/tasks", (req, res) => {
    const status = req.query.status;
    if (status !== undefined && (typeof status !== "string" || !TASK_STATUSES.has(status as TaskStatus))) {
      res.status(400).json({ error: { code: "validation", message: "status must be open, in-progress, or done" } });
      return;
    }
    res.json(tasks.list(status as TaskStatus | undefined));
  });
  api.get("/tasks/:id", (req, res) => {
    const task = tasks.get(req.params.id);
    if (task === undefined) notFound(res, req.params.id);
    else res.json(task);
  });
  api.post("/tasks", (req, res) => {
    const title = text(req.body?.title);
    if (title === undefined) {
      res.status(400).json({ error: { code: "validation", message: "title is required" } });
      return;
    }
    const priority = req.body?.priority;
    if (priority !== undefined && !TASK_PRIORITIES.has(priority as TaskPriority)) {
      res.status(400).json({ error: { code: "validation", message: "priority must be low, medium, or high" } });
      return;
    }
    const assigneeName = text(req.body?.assignee);
    const assignee: TeamMember | undefined = assigneeName === undefined ? undefined : {
      id: `member-${assigneeName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      name: assigneeName,
      initials: assigneeName.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase(),
    };
    res.status(201).json(tasks.create({
      title,
      ...(text(req.body?.description) === undefined ? {} : { description: text(req.body.description)! }),
      ...(assignee === undefined ? {} : { assignee }),
      ...(priority === undefined ? {} : { priority: priority as TaskPriority }),
      ...(text(req.body?.dueDate) === undefined ? {} : { dueDate: text(req.body.dueDate)! }),
    }));
  });
  api.post("/tasks/:id/complete", (req, res) => {
    const task = tasks.complete(req.params.id);
    if (task === undefined) notFound(res, req.params.id);
    else res.json(task);
  });
  api.delete("/tasks/:id", (req, res) => {
    if (!tasks.delete(req.params.id)) notFound(res, req.params.id);
    else res.json({ deleted: true, id: req.params.id });
  });
  app.use("/api", api);
  app.use("/api", (_req, res) => res.status(404).json({ error: { code: "not-found", message: "Unknown API route" } }));

  app.use(express.static(CLIENT_DIST));
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "GET") {
      next();
      return;
    }
    res.sendFile(resolve(CLIENT_DIST, "index.html"));
  });

  return { app, tasks, vendo };
}

function isEntrypoint(): boolean {
  return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

if (isEntrypoint()) {
  const port = Number(process.env.PORT ?? 3210);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`Invalid PORT: ${process.env.PORT}`);
  createRelayServer().app.listen(port, () => {
    console.log(`Relay listening at http://localhost:${port}`);
  });
}
