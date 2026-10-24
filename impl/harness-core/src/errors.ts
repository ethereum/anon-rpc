// §12 — errors that cross a harness boundary.
//
// `name` and `code` cross intact, because host logic may branch on `code`;
// `message` crosses for humans and must never be branched on.

export type SerializedError = { name: string; message: string; code?: string };

export class RpcError extends Error {
  code?: string;
  constructor(e: SerializedError) {
    super(e.message);
    this.name = e.name;
    this.code = e.code;
  }
}

/** The one error-marshalling implementation; pair with `new RpcError(...)` to deserialize. */
export function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return {
      name: err.name,
      message: err.message,
      ...(typeof code === "string" ? { code } : {}),
    };
  }
  return { name: "Error", message: String(err) };
}
