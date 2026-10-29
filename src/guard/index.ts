/**
 * hapi-guard: the Pi extension that guards a worker run (design §6a). Plan 02
 * Task 4 bundles this entry into build/pi/extensions/hapi-guard.js; this
 * placeholder only lets the bundle build. Task 5 replaces it with the real guard.
 *
 * Until then the factory registers only a `session_start` handler that throws, so
 * a placeholder bundle fails its node before any request instead of running
 * unguarded (spike 08, finding 8).
 */
interface PiExtensionApi {
  on(event: string, handler: (...args: unknown[]) => unknown): void;
}

export default function hapiGuard(pi: PiExtensionApi): void {
  pi.on("session_start", () => {
    throw new Error("hapi-guard: placeholder (Plan 02 Task 5)");
  });
}
