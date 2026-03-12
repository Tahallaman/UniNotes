import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { CONFIG } from "../../config.js";
import { log } from "../utils/logger.js";

/**
 * Run the raw lecture notes through Claude Code print mode to produce
 * a polished "pretty" version. Returns the pretty markdown string.
 */
export async function prettifyNotes(rawFilePath: string): Promise<string> {
  const promptsFile = path.join(CONFIG.paths.prompts, "pretty-notes.txt");

  if (!fs.existsSync(promptsFile)) {
    throw new Error(`Pretty-notes prompt file not found: ${promptsFile}`);
  }

  const rawContent = fs.readFileSync(rawFilePath, "utf-8");
  const rules = fs.readFileSync(promptsFile, "utf-8");

  // Prepend an explicit no-tools instruction plus the formatting rules so
  // Claude outputs raw markdown to stdout rather than attempting file writes.
  // NOTE: --allowedTools "" is unreliable on Windows (cmd.exe drops the empty
  // arg), so we rely on the prompt instruction instead.
  const stdinContent = [
    "IMPORTANT: You are running in automated stdout-capture mode.",
    "Output ONLY raw markdown text. Do NOT use any tools (Write, Edit, Bash, etc.).",
    "Do NOT describe what you are doing. Do NOT ask for approval.",
    "Your entire response is read directly from stdout by the calling program.",
    "",
    "FORMATTING RULES:",
    rules,
    "",
    "---",
    "",
    "LECTURE NOTES TO FORMAT:",
    rawContent,
  ].join("\n");

  log.info(`Prettifying notes: ${rawFilePath}`);

  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      "claude",
      [
        "-p",
        "--allowedTools", "none",
        "Reformat the lecture notes according to the FORMATTING RULES above. Output ONLY the polished markdown, nothing else.",
      ],
      {
        cwd: CONFIG.rootDir,
        stdio: ["pipe", "pipe", "pipe"],
        shell: true,
      },
    );

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errChunks.push(chunk));

    child.on("error", (err) => reject(new Error(`Failed to spawn claude: ${err.message}`)));

    child.on("close", (code) => {
      const stdout = Buffer.concat(chunks).toString("utf-8");
      const stderr = Buffer.concat(errChunks).toString("utf-8");

      if (code !== 0) {
        reject(new Error(`claude exited with code ${code}: ${stderr.slice(0, 500)}`));
        return;
      }

      if (!stdout || stdout.trim().length < 100) {
        reject(new Error(`Claude returned unexpectedly short output (${stdout?.length ?? 0} chars)`));
        return;
      }

      log.info(`Pretty notes generated: ${stdout.length} chars`);
      resolve(stdout);
    });

    child.stdin.write(stdinContent);
    child.stdin.end();

    // Timeout after 5 minutes
    setTimeout(() => {
      child.kill();
      reject(new Error("claude process timed out after 5 minutes"));
    }, 5 * 60_000);
  });
}
