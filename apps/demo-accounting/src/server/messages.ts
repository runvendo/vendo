import { recordActivity } from "./activity"
import { getStore } from "./store"
import type { Message, MessageDirection } from "./types"

export class ClientNotFoundError extends Error {
  constructor(clientId: string) {
    super(`Unknown client: ${clientId}`)
    this.name = "ClientNotFoundError"
  }
}

let counter = 0

export function sendMessage(
  clientId: string,
  direction: MessageDirection,
  author: string,
  body: string,
): Message {
  const store = getStore()
  const client = store.clients.find(c => c.id === clientId)
  if (!client) throw new ClientNotFoundError(clientId)

  const message: Message = {
    id: `msg_live_${++counter}`,
    clientId,
    direction,
    author,
    body: body.trim(),
    sentAt: new Date().toISOString(),
  }
  store.messages.push(message)
  recordActivity(
    "message_sent",
    direction === "firm"
      ? `${author} messaged ${client.businessName}`
      : `${author} sent a message on ${client.businessName}`,
    clientId,
  )
  return message
}
