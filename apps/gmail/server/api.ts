/**
 * The Gmail clone's own REST API — the host contract Flowlet's agent acts
 * through as the signed-in user (ENG-202). Routes mirror openapi.json exactly;
 * the spec is the reviewable source of truth for the tool surface.
 */
import { Router, type Request, type Response } from "express";
import { MailStore, UnknownMessageError, type MailFolder } from "./store";

const FOLDERS = new Set<MailFolder>(["inbox", "sent", "trash"]);

function parseBool(value: unknown): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

export function createMailApi(store: MailStore): Router {
  const api = Router();

  api.get("/profile", (_req, res) => {
    res.json({ user: store.me });
  });

  api.get("/messages", (req, res) => {
    const folderRaw = req.query.folder;
    const folder =
      typeof folderRaw === "string" && FOLDERS.has(folderRaw as MailFolder)
        ? (folderRaw as MailFolder)
        : undefined;
    if (typeof folderRaw === "string" && !folder) {
      res.status(400).json({ error: `unknown folder "${folderRaw}"` });
      return;
    }
    const limitRaw = Number(req.query.limit);
    const messages = store.list({
      folder,
      unread: parseBool(req.query.unread),
      starred: parseBool(req.query.starred),
      q: typeof req.query.q === "string" ? req.query.q : undefined,
      limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined,
    });
    res.json({ messages });
  });

  api.get("/messages/:id", (req, res) => {
    const message = store.get(req.params.id);
    if (!message) {
      res.status(404).json({ error: `unknown message "${req.params.id}"` });
      return;
    }
    res.json({ message });
  });

  api.post("/messages/send", (req, res) => {
    const body = req.body ?? {};
    withStore(res, () => {
      const message = store.send({
        to: typeof body.to === "string" ? body.to : undefined,
        subject: typeof body.subject === "string" ? body.subject : undefined,
        body: typeof body.body === "string" ? body.body : "",
        inReplyTo: typeof body.inReplyTo === "string" ? body.inReplyTo : undefined,
      });
      res.json({ message });
    });
  });

  api.delete("/messages/:id", (req, res) => {
    withStore(res, () => {
      res.json({ message: store.delete(req.params.id) });
    });
  });

  api.post("/messages/:id/read", (req, res) => {
    const read = req.body?.read;
    if (typeof read !== "boolean") {
      res.status(400).json({ error: "`read` (boolean) is required" });
      return;
    }
    withStore(res, () => {
      res.json({ message: store.markRead(req.params.id, read) });
    });
  });

  api.post("/messages/:id/star", (req, res) => {
    const starred = req.body?.starred;
    if (typeof starred !== "boolean") {
      res.status(400).json({ error: "`starred` (boolean) is required" });
      return;
    }
    withStore(res, () => {
      res.json({ message: store.setStarred(req.params.id, starred) });
    });
  });

  return api;
}

/** Map store errors to HTTP: unknown id → 404, invalid input → 400. */
function withStore(res: Response, fn: () => void): void {
  try {
    fn();
  } catch (error) {
    if (error instanceof UnknownMessageError) {
      res.status(404).json({ error: error.message });
      return;
    }
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
}
