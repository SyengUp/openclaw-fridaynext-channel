/**
 * Dynamic-import a file by filesystem path.
 *
 * Node ESM `import()` accepts POSIX absolute paths (`/opt/…`) as specifiers, but
 * rejects a Windows drive path (`C:\…`) — that must be a `file://` URL. Wrapping
 * every absolute import with `pathToFileURL` is a no-op on Mac/Linux
 * (`/opt/foo.js` → `file:///opt/foo.js`, which Node already loads) and the
 * only form that works on Windows.
 */
import { pathToFileURL } from "node:url";

export function absoluteModuleSpecifier(absPath: string): string {
  return pathToFileURL(absPath).href;
}

export function importAbsoluteModule(absPath: string): Promise<unknown> {
  return import(absoluteModuleSpecifier(absPath));
}
