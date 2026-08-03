import { recordActivity } from "./activity"
import { DomainError } from "./errors"
import { getStore } from "./store"
import type { Message, MessageDirection } from "./types"

let counter = 0

export function sendMessage(
  clientId: string,
  direction: MessageDirection,
  author: string,
  body: string,
): Message {
  const store = getStore()
  const client = store.clients.find(c => c.id === clientId)
  if (!client) throw new DomainError("not_found", `Unknown client: ${clientId}`)

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
