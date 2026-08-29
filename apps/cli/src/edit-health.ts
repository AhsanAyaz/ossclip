import { z } from "zod/v4";

/**
 * The edit server's identity endpoint — ONE spelling, shared by the route that
 * serves it (edit.ts) and the probe that reads it (edit-port.ts).
 *
 * It exists for the port-conflict flow: `ossclip edit` on a taken 5174 used to
 * die with a raw EADDRINUSE stack, and the only way to tell "my own editor is
 * already open on this project" from "something else owns this port" is to ask
 * whoever answers. Two copies of this contract would mean an attach that
 * silently stops working the day one side adds a field.
 *
 * Nothing here may carry a secret. The workdir path is the one path included,
 * and only because `/api/production` already serves it to the same loopback
 * origin — it IS the thing the caller has to compare.
 */
export const EDIT_HEALTH_PATH = "/api/health";

/**
 * Parsed, never cast (CLAUDE.md): whatever answers on 127.0.0.1:<port> is an
 * unknown process until it proves otherwise, and a dev server that happens to
 * serve JSON at /api/health must read as a STRANGER — the flow kills a pid it
 * gets from here, so `app: "ossclip"` is a literal and the pid is a positive
 * integer or the whole body is rejected.
 *
 * `workdir` is nullable because the server legitimately runs with no project
 * open (R17 §83's picker state); `version` is optional so an install that
 * cannot read its own manifest still identifies itself.
 */
export const EditHealthSchema = z.object({
  app: z.literal("ossclip"),
  version: z.string().optional(),
  workdir: z.string().nullable(),
  pid: z.number().int().positive(),
});
export type EditHealth = z.infer<typeof EditHealthSchema>;

/** The route's body, built through the schema's own type so a field added to
 * one side cannot miss the other. */
export function editHealthBody(o: {
  version?: string | undefined;
  workdir: string | null;
  pid: number;
}): EditHealth {
  return {
    app: "ossclip",
    ...(o.version !== undefined ? { version: o.version } : {}),
    workdir: o.workdir,
    pid: o.pid,
  };
}
