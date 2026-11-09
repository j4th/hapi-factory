/**
 * The one check a `-v src:dst` mount's source needs, shared by the launcher (./spec.ts, ./disk.ts, ./sidecar.ts) and
 * the audit's validation run (src/audit/checks/tools.ts). A leaf module, importing nothing, so neither side imports
 * the other for it (D29: it ended the cycle spec.ts → tools.ts → generated.ts → runtime.ts → spec.ts).
 */

/** A path a `-v src:dst` mount can hold, else throws naming `into`. */
export function mountable(path: string, into = "the validation container"): string {
  if (path.includes(":") || path.includes(",")) throw new Error(`cannot mount ${path} into ${into}: its path holds ":" or ","`);
  return path;
}
