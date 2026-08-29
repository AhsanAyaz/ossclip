import { basename, resolve } from "node:path";
import { EDIT_HEALTH_PATH, EditHealthSchema, type EditHealth } from "./edit-health";
import type { EditServer } from "./edit";
import { assertInteractive, isInteractive, select, unwrap } from "./interactive/prompts";

/**
 * What `ossclip edit` does when its port is already taken.
 *
 * The failure this replaces was a raw Node `EADDRINUSE` stack plus an
 * `ELIFECYCLE` from the package manager — recurring, and almost always the
 * user's OWN editor already open on the SAME project, i.e. a situation with an
 * obviously right answer (attach to it) that the tool refused to take.
 *
 * The decision is pure (`resolvePortConflict`) and the sockets, prompts and
 * kills live in `openEditServer` below — the `openCommand`/`openInBrowser`
 * split, so the whole matrix is testable without a TTY or a second server.
 */

/** How many ports past the requested one an automatic bump will try. */
export const PORT_BUMP_ATTEMPTS = 20;

/** Who is holding the port, as far as `/api/health` would say. */
export interface PortHolder {
  pid: number;
  /** Null when that server is sitting on the project picker (R17 §83). */
  workdir: string | null;
}

/**
 * The four things that can happen to a requested port. Every one of them
 * carries its own user-facing sentence, so the wording is pinned by the pure
 * test rather than by whoever reads the terminal that day.
 */
export type PortDecision =
  /** Our own editor, same project: print and reuse it. */
  | { kind: "attach"; url: string; message: string }
  /** Our own editor, another project, at a TTY: the three-way prompt. */
  | { kind: "ask"; holder: PortHolder; message: string }
  /** Move to the next free port and say why. */
  | { kind: "bump"; message: string }
  /** Refuse, because the user named this port explicitly. */
  | { kind: "refuse"; message: string };

/** How a workdir is named in a message: the basename, which is what a user
 * recognises, with the null (picker) server spelled out rather than printed as
 * an empty pair of quotes. */
function holderName(workdir: string | null): string {
  return workdir === null ? "no project (the picker)" : `"${basename(workdir)}"`;
}

/**
 * Same project or not. Both sides go through `resolve` because one may have
 * come from a typed relative path while the server always reports a resolved
 * one; two spellings of the same directory must not read as two projects.
 * Symlinked temp roots (macOS `/var` → `/private/var`) can still disagree —
 * that degrades to the prompt, never to a wrong attach.
 */
function sameProject(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return resolve(a) === resolve(b);
}

/**
 * The whole port-conflict matrix, as one pure function.
 *
 * `pinned` means the user TYPED `--port` (commander's `getOptionValueSource`,
 * the `--sort` idiom). It never changes attach or the prompt — those are still
 * what the user wants — it only forbids the silent bump: someone who names a
 * port has a reason (a bookmark, a tunnel, a proxy config), and quietly serving
 * on a different one hands them a page that never loads.
 *
 * A process that does not identify as ossclip is NEVER killed and never
 * prompted about: it is not ours to stop.
 */
export function resolvePortConflict(input: {
  health: EditHealth | null;
  port: number;
  /** The workdir this run is opening; null when opening the picker. */
  workdir: string | null;
  interactive: boolean;
  pinned: boolean;
}): PortDecision {
  const { health, port, workdir, interactive, pinned } = input;
  const url = `http://127.0.0.1:${port}`;
  if (health === null) {
    // A stranger. Bump around it, or — when the port was named — say so and
    // stop, since "free it" is the only thing we could honestly suggest.
    return pinned
      ? {
          kind: "refuse",
          message:
            `port ${port} is taken by something that isn't ossclip — stop it, ` +
            "or pass a different `--port <n>`.",
        }
      : {
          kind: "bump",
          message: `▸ port ${port} is taken by another program — using the next free port`,
        };
  }
  if (sameProject(health.workdir, workdir)) {
    return { kind: "attach", url, message: `▸ already open at ${url}` };
  }
  const holder: PortHolder = { pid: health.pid, workdir: health.workdir };
  if (interactive) {
    return {
      kind: "ask",
      holder,
      message: `port ${port} is already serving ${holderName(health.workdir)} (pid ${health.pid})`,
    };
  }
  // No TTY: nobody can answer, so never block a script on a question.
  return pinned
    ? {
        kind: "refuse",
        message:
          `port ${port} is already serving ${holderName(health.workdir)} (pid ${health.pid}) — ` +
          `stop it, or pass a different \`--port <n>\`.`,
      }
    : {
        kind: "bump",
        message:
          `▸ port ${port} is serving ${holderName(health.workdir)} (pid ${health.pid}) — ` +
          "using the next free port",
      };
}

/** The give-up sentence when a whole block of ports is occupied — pure so the
 * number in it can never drift from `PORT_BUMP_ATTEMPTS`. */
export function portsExhaustedMessage(from: number, attempts: number): string {
  return (
    `ports ${from}-${from + attempts - 1} are all taken — free one, or pass ` +
    "`--port <n>` to pick another."
  );
}

/** Node's "already bound" as a predicate, so no call site has to cast an
 * unknown catch value into an ErrnoException. */
export function isAddrInUse(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === "EADDRINUSE"
  );
}

/**
 * Ask whoever answered on `port` who they are. Null for anything that is not a
 * well-formed ossclip health body — a timeout, a refused connection, a page
 * that 404s, an unrelated JSON API.
 *
 * The timeout is short on purpose: this sits between the user and their editor
 * opening, and a process that has a socket bound but never answers must cost a
 * blink, not a hang.
 */
export async function probeEditHealth(
  port: number,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<EditHealth | null> {
  try {
    const res = await (opts.fetchImpl ?? fetch)(`http://127.0.0.1:${port}${EDIT_HEALTH_PATH}`, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? 500),
    });
    if (!res.ok) return null;
    const parsed = EditHealthSchema.safeParse(await res.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The I/O the bind flow needs, each piece injectable — tests drive the whole
 * ladder with no TTY, no browser and no signals. */
export interface EditPortDeps {
  /** Start a server on exactly this port; rejects with EADDRINUSE when taken. */
  start: (port: number) => Promise<EditServer>;
  health: (port: number) => Promise<EditHealth | null>;
  interactive: boolean;
  ask: (d: { message: string; holder: PortHolder; port: number }) => Promise<"stop" | "next" | "cancel">;
  kill: (pid: number) => void;
  log: (line: string) => void;
  wait: (ms: number) => Promise<void>;
}

export type OpenEditServerResult =
  | { kind: "started"; server: EditServer }
  /** Someone else's process is serving this project already — nothing to run. */
  | { kind: "attached"; url: string }
  /** The user chose "cancel" at the prompt: exit 0, having changed nothing. */
  | { kind: "cancelled" };

/** How long we give a stopped server to release the socket before bumping —
 * a SIGTERM is not instant, and the listener lingers in the kernel briefly
 * after the process is gone. */
const STOP_WAIT_MS = 2000;
const STOP_POLL_MS = 100;

/**
 * Bind, or do the right thing about not being able to. Returns rather than
 * exits so the caller keeps ownership of the browser open and the telemetry
 * line; throws only for the refusals, which are real errors.
 */
export async function openEditServer(
  workdir: string | null,
  opts: { port: number; pinned: boolean },
  deps: EditPortDeps,
): Promise<OpenEditServerResult> {
  const tryStart = async (port: number): Promise<EditServer | null> => {
    try {
      return await deps.start(port);
    } catch (err) {
      // Only EADDRINUSE is a port conflict. EACCES on a privileged port, a
      // bad interface, anything else — that is the user's real error and it
      // must not be swallowed by a silent bump to port+1.
      if (!isAddrInUse(err)) throw err;
      return null;
    }
  };
  const bumpFrom = async (from: number): Promise<OpenEditServerResult> => {
    for (let port = from; port < from + PORT_BUMP_ATTEMPTS; port++) {
      const server = await tryStart(port);
      if (server !== null) return { kind: "started", server };
    }
    throw new Error(portsExhaustedMessage(from, PORT_BUMP_ATTEMPTS));
  };

  const first = await tryStart(opts.port);
  if (first !== null) return { kind: "started", server: first };

  const decision = resolvePortConflict({
    health: await deps.health(opts.port),
    port: opts.port,
    workdir,
    interactive: deps.interactive,
    pinned: opts.pinned,
  });
  if (decision.kind === "refuse") throw new Error(decision.message);
  if (decision.kind === "attach") {
    deps.log(decision.message);
    return { kind: "attached", url: decision.url };
  }
  if (decision.kind === "bump") {
    deps.log(decision.message);
    return await bumpFrom(opts.port + 1);
  }

  const answer = await deps.ask({ message: decision.message, holder: decision.holder, port: opts.port });
  if (answer === "cancel") return { kind: "cancelled" };
  if (answer === "next") return await bumpFrom(opts.port + 1);

  // "Stop it and take the port". The pid came from a body that had to say
  // `app: "ossclip"` to parse at all, so this can only ever signal our own
  // editor. A kill that throws (ESRCH — it exited between the probe and now)
  // is the outcome we wanted anyway, so it falls through to the same retry.
  try {
    deps.kill(decision.holder.pid);
  } catch {
    // already gone
  }
  for (let waited = 0; waited < STOP_WAIT_MS; waited += STOP_POLL_MS) {
    await deps.wait(STOP_POLL_MS);
    const server = await tryStart(opts.port);
    if (server !== null) return { kind: "started", server };
  }
  // It refused to die (or something else grabbed the port in the gap). Say so
  // rather than looping forever — the editor still opens, just elsewhere.
  deps.log(`▸ port ${opts.port} is still busy — using the next free port`);
  return await bumpFrom(opts.port + 1);
}

/**
 * The real seams. The prompt is `select` + `unwrap` like every other choice in
 * this CLI, so Esc/Ctrl-C exits 0 with "nothing changed" instead of a stack.
 */
export function liveEditPortDeps(start: (port: number) => Promise<EditServer>): EditPortDeps {
  return {
    start,
    health: (port) => probeEditHealth(port),
    interactive: isInteractive(),
    ask: async ({ message, holder, port }) => {
      assertInteractive("the edit port conflict prompt");
      return unwrap(
        await select({
          message: `${message} — what now?`,
          options: [
            { value: "stop", label: `Stop it and take port ${port}` },
            { value: "next", label: "Open this project on the next free port" },
            { value: "cancel", label: "Cancel" },
          ],
        }),
      ) as "stop" | "next" | "cancel";
    },
    kill: (pid) => process.kill(pid),
    log: (line) => console.log(line),
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}
