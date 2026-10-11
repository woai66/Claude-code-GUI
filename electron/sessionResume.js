import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const CLAUDE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 只允许本地桌面页在指定目录恢复 Claude 会话，不向页面开放任意命令执行。 */
export function registerSessionResumeHandler({
  ipcMain,
  assertLocalPage,
  platform = process.platform,
  spawnProcess = spawn,
}) {
  ipcMain.handle('claude-gui:resume-claude-session', async (event, sessionId, projectPath) => {
    assertLocalPage(event);
    if (platform !== 'win32') return { error: 'unsupported' };
    if (typeof sessionId !== 'string' || !CLAUDE_SESSION_ID.test(sessionId)) {
      return { error: 'invalid-session' };
    }
    if (typeof projectPath !== 'string' || projectPath.includes('\0') || !path.isAbsolute(projectPath)) {
      return { error: 'directory-unavailable' };
    }

    try {
      if (!(await fs.stat(projectPath)).isDirectory()) return { error: 'directory-unavailable' };
    } catch {
      return { error: 'directory-unavailable' };
    }

    const cwd = path.resolve(projectPath);
    const powershellPath = path.join(
      process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
    );
    // 单引号字面量配合编码参数，目录中的引号、空格和 $ 都不会成为 PowerShell 代码。
    const quotedPath = cwd.replaceAll("'", "''");
    const command = [
      `Set-Location -LiteralPath '${quotedPath}'`,
      'try {',
      `  & claude --resume '${sessionId}'`,
      '} catch {',
      '  Write-Host $_.Exception.Message -ForegroundColor Red',
      '}',
    ].join('\n');
    const encodedCommand = Buffer.from(command, 'utf16le').toString('base64');
    // 由 Windows 创建带控制台的窗口；直接 detached + 忽略 stdio 会丢失交互输入。
    const launcher = [
      "$ErrorActionPreference = 'Stop'",
      'try {',
      [
        `  Start-Process -FilePath '${powershellPath.replaceAll("'", "''")}' -WorkingDirectory '${quotedPath}'`,
        `-ArgumentList @('-NoLogo', '-NoExit', '-EncodedCommand', '${encodedCommand}') -WindowStyle Normal`,
      ].join(' '),
      '  exit 0',
      '} catch {',
      '  exit 1',
      '}',
    ].join('\n');
    const env = { ...process.env };
    // 新窗口独立于 GUI 和它的启动终端，不应被识别为嵌套 Claude 会话。
    delete env.CLAUDECODE;
    delete env.ELECTRON_RUN_AS_NODE;

    try {
      await new Promise((resolve, reject) => {
        const child = spawnProcess(powershellPath, [
          '-NoLogo', '-NoProfile', '-NonInteractive',
          '-EncodedCommand', Buffer.from(launcher, 'utf16le').toString('base64'),
        ], {
          cwd,
          env,
          stdio: 'ignore',
          windowsHide: true,
        });
        child.once('error', reject);
        child.once('exit', (code) => {
          if (code === 0) resolve();
          else reject(new Error('PowerShell launcher failed'));
        });
      });
      return { success: true };
    } catch {
      return { error: 'launch-failed' };
    }
  });
}
