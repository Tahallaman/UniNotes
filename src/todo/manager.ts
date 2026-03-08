import fs from "node:fs";
import { CONFIG } from "../../config.js";
import { log } from "../utils/logger.js";
import type { ParsedActions } from "../notes/parser.js";

const WATCH_HEADER = "## Watch Reminders";
const ACTION_HEADER = "## Action Items";

interface TodoEntry {
  title: string;
  courseCode: string;
  panoptoUrl: string;
  actions: ParsedActions | null;
}

/**
 * Append a watch reminder and action items to TODO.md.
 */
export function appendTodoItems(entry: TodoEntry): void {
  const todoPath = CONFIG.paths.todo;
  let content = "";

  if (fs.existsSync(todoPath)) {
    content = fs.readFileSync(todoPath, "utf-8");
  }

  // Ensure sections exist
  if (!content.includes(WATCH_HEADER)) {
    content = `# UniNotes TODO\n\n${WATCH_HEADER}\n\n${ACTION_HEADER}\n\n`;
  }

  const dateStr = new Date().toISOString().slice(0, 10);

  // Skip if this lecture is already in the file (idempotent re-runs)
  if (content.includes(entry.panoptoUrl)) {
    log.info(`TODO.md already contains entry for: ${entry.title}`);
    return;
  }

  // Build watch reminder
  const watchEntry = [
    `- [ ] **${entry.courseCode}** — ${entry.title}`,
    `  [Watch on Panopto](${entry.panoptoUrl})`,
    `  Added: ${dateStr}`,
    "",
  ].join("\n");

  // Insert watch reminder after the Watch Reminders header
  content = insertAfterHeader(content, WATCH_HEADER, watchEntry);

  // Build action items (if structured data available)
  if (entry.actions?.actionItems?.length) {
    const actionBlock = [
      `### ${entry.courseCode} — ${entry.title}`,
      ...entry.actions.actionItems.map((item) => `- [ ] ${item}`),
      "",
    ].join("\n");

    content = insertAfterHeader(content, ACTION_HEADER, actionBlock);
  }

  fs.writeFileSync(todoPath, content, "utf-8");
  log.info(`TODO.md updated for: ${entry.title}`);
}

/**
 * Insert text after a section header.
 */
function insertAfterHeader(content: string, header: string, text: string): string {
  const idx = content.indexOf(header);
  if (idx === -1) return content + "\n" + header + "\n\n" + text;

  const afterHeader = idx + header.length;
  // Find the next newline(s) after the header
  const restAfterHeader = content.slice(afterHeader);
  const firstContentIdx = restAfterHeader.search(/[^\n]/);
  const insertPoint = afterHeader + (firstContentIdx === -1 ? restAfterHeader.length : firstContentIdx);

  return content.slice(0, insertPoint) + text + "\n" + content.slice(insertPoint);
}
