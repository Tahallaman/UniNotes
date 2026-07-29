import fs from "node:fs";
import { CONFIG } from "../../config.js";

/** Ensure all required directories exist at startup. */
export function ensureDirectories(): void {
  const dirs = [
    CONFIG.paths.temp,
    CONFIG.paths.lectures,
    CONFIG.paths.logs,
    CONFIG.paths.browserData.panopto,
    CONFIG.paths.browserData.gemini,
    CONFIG.paths.incoming,
    CONFIG.paths.videoCache,
  ];

  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
