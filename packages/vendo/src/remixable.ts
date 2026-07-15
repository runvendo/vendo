export interface RemixableRegistration {
  name: string;
  component: unknown;
  exportable?: boolean;
  remixable?: boolean;
}

export interface RemixableReportOptions {
  /** Vendo wire base. Defaults to the umbrella's standard `/api/vendo`. */
  baseUrl?: string;
}

function developmentBrowser(): boolean {
  return typeof window !== "undefined"
    && typeof process !== "undefined"
    && process.env.NODE_ENV === "development";
}

/**
 * Marks a host component registration remixable without changing its runtime
 * shape. Passing `import.meta.url` lets a development Vendo server capture the
 * registration module when static sync cannot resolve the component.
 */
export function remixable<T extends RemixableRegistration>(
  registration: T,
  moduleSource: string,
  options: RemixableReportOptions = {},
): T & { remixable: true } {
  const marked = { ...registration, remixable: true };
  if (developmentBrowser()) {
    const baseUrl = (options.baseUrl ?? "/api/vendo").replace(/\/$/, "");
    queueMicrotask(() => {
      void globalThis.fetch(`${baseUrl}/dev/remixable-source`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slot: registration.name,
          source: moduleSource,
          exportable: registration.exportable === true,
        }),
      }).then((response) => {
        if (!response.ok) throw new Error(`runtime capture returned ${response.status}`);
      }).catch((error: unknown) => {
        console.warn(`Vendo could not runtime-capture remixable slot ${registration.name}:`, error);
      });
    });
  }
  return marked;
}
