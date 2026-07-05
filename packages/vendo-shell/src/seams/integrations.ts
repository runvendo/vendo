/** A connectable tool. Real Composio OAuth metadata is wired by F2. */
export interface Integration {
  id: string;
  name: string;
  connected: boolean;
  logo?: string;
}

/** Tool-connection seam. */
export interface VendoIntegrations {
  list(): Promise<Integration[]>;
  connect(id: string): Promise<Integration>;
  disconnect(id: string): Promise<Integration>;
}

export function createLocalIntegrations(seed: Integration[]): VendoIntegrations {
  const map = new Map<string, Integration>(seed.map((i) => [i.id, i]));
  const set = (id: string, connected: boolean): Integration => {
    const found = map.get(id);
    if (!found) throw new Error(`unknown integration: ${id}`);
    const next = { ...found, connected };
    map.set(id, next);
    return next;
  };
  return {
    async list() {
      return [...map.values()];
    },
    async connect(id) {
      return set(id, true);
    },
    async disconnect(id) {
      return set(id, false);
    },
  };
}
