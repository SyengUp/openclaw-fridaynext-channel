import { rmSync } from "node:fs";
import { join } from "node:path";

rmSync(join(import.meta.dirname, "..", "dist"), { recursive: true, force: true });
