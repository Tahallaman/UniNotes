/**
 * Hide a process's top-level windows on Windows.
 *
 * This is the closest practical equivalent to Xvfb here: Windows has no
 * drop-in invisible display for arbitrary desktop apps, so instead of faking a
 * display we keep a genuinely headed browser and hide its windows.
 *
 * Headed matters because Google blocks sign-in from headless browsers. A hidden
 * window is still a real headed browser as far as fingerprinting is concerned.
 *
 * Relies on the browser being launched with --disable-backgrounding-occluded-windows
 * and friends (see browserPool.ts), otherwise Chrome treats a hidden window as
 * occluded and throttles its renderers.
 */

import { spawn } from "node:child_process";
import { log } from "./logger.js";

/**
 * PowerShell that finds every browser process whose command line references our
 * profile directory, then hides each of their visible top-level windows via
 * ShowWindow(hwnd, SW_HIDE).
 *
 * Matching on the profile dir rather than a PID is deliberate: Playwright does
 * not expose the browser process, and Chromium's visible window frequently
 * belongs to a child process rather than the one we launched.
 */
const HIDE_SCRIPT = String.raw`
param([string]$ProfileDir)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Hide {
  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);
}
"@

$pids = New-Object System.Collections.Generic.HashSet[uint32]
Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe' OR Name = 'chrome.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($ProfileDir) } |
  ForEach-Object { [void]$pids.Add([uint32]$_.ProcessId) }

if ($pids.Count -eq 0) { Write-Output 0; return }

$hidden = 0
$callback = [Win32Hide+EnumWindowsProc]{
  param($hWnd, $lParam)
  $owner = [uint32]0
  [void][Win32Hide]::GetWindowThreadProcessId($hWnd, [ref]$owner)
  if ($pids.Contains($owner) -and [Win32Hide]::IsWindowVisible($hWnd)) {
    [void][Win32Hide]::ShowWindow($hWnd, 0)  # SW_HIDE
    $script:hidden++
  }
  return $true
}
[void][Win32Hide]::EnumWindows($callback, [IntPtr]::Zero)
Write-Output $hidden
`;

/**
 * Hide the windows of the browser running out of `profileDir`.
 *
 * Best-effort. A failure here is cosmetic — the browser still works, it's just
 * visible — so this never throws.
 */
export async function hideBrowserWindows(profileDir: string): Promise<void> {
  if (process.platform !== "win32") {
    log.warn('browser.windowMode "hidden" is Windows-only — ignoring.');
    return;
  }

  // Chromium creates its window shortly after launch; hiding too early is a no-op.
  await new Promise((r) => setTimeout(r, 1_500));

  try {
    const hidden = await runPowerShell(HIDE_SCRIPT, profileDir);
    if (hidden > 0) {
      log.info(`Hid ${hidden} browser window(s).`);
    } else {
      log.warn("No visible browser windows found to hide — it may still be starting.");
    }
  } catch (err) {
    log.warn(`Could not hide browser window: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function runPowerShell(script: string, profileDir: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "-"],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );

    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(err.trim().slice(0, 300) || `powershell exited ${code}`));
        return;
      }
      resolve(parseInt(out.trim().split(/\s+/).pop() || "0", 10) || 0);
    });

    // `param(...)` must be the first statement, so the arg is appended as a call.
    // Single quotes keep the path literal; '' is PowerShell's escaped quote.
    const quoted = profileDir.replace(/'/g, "''");
    child.stdin.write(`& {${script}} -ProfileDir '${quoted}'\n`);
    child.stdin.end();

    const timer = setTimeout(() => child.kill(), 20_000);
    child.on("close", () => clearTimeout(timer));
  });
}
