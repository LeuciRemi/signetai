import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	BaseConnector,
	type InstallResult,
	type UninstallResult,
} from "@signet/connector-base";

const SHELL_BLOCK_START = "# >>> signet codex >>>";
const SHELL_BLOCK_END = "# <<< signet codex <<<";
const SHELL_BLOCK = `${SHELL_BLOCK_START}
if [ -d "$HOME/.config/signet/bin" ]; then
	case ":$PATH:" in
		*":$HOME/.config/signet/bin:"*) ;;
		*) export PATH="$HOME/.config/signet/bin:$PATH" ;;
	esac
fi
${SHELL_BLOCK_END}
`;

function stripBlock(content: string): string {
	const start = content.indexOf(SHELL_BLOCK_START);
	if (start < 0) return content;
	const end = content.indexOf(SHELL_BLOCK_END, start);
	if (end < 0) return content;
	const after = content.slice(end + SHELL_BLOCK_END.length);
	const before = content.slice(0, start).trimEnd();
	return `${before}${before ? "\n\n" : ""}${after.trimStart()}`.trimEnd() + "\n";
}

function appendBlock(content: string): string {
	const stripped = stripBlock(content).trimEnd();
	return `${stripped}${stripped ? "\n\n" : ""}${SHELL_BLOCK}`;
}

function shellSingleQuote(value: string): string {
	return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function buildWrapper(realCodexBin: string): string {
	return `#!/bin/sh
set -eu

REAL_CODEX_BIN=${shellSingleQuote(realCodexBin)}
SIGNET_BIN="\${SIGNET_CODEX_SIGNET_BIN:-signet}"
SESSION_ROOT="\${HOME}/.codex/sessions"
TMP_ROOT="\${TMPDIR:-/tmp}/signet-codex-\$\$"
SESSION_KEY=""
START_MARKER=""
INSTRUCTIONS_FILE=""

cleanup() {
	rm -rf "$TMP_ROOT"
}

# Escape a string for embedding in a JSON value (backslash, double-quote, newlines)
json_escape() {
	printf '%s' "$1" | sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g' -e 's/	/\\\\t/g' | tr '\\n' ' '
}

session_start() {
	mkdir -p "$TMP_ROOT"
	START_MARKER="$TMP_ROOT/start.marker"
	INSTRUCTIONS_FILE="$TMP_ROOT/model-instructions.md"
	: > "$START_MARKER"
	SESSION_KEY="$(uuidgen 2>/dev/null || printf "codex-%s-%s" "$(date +%s)" "$$")"

	payload="$(printf '{"session_id":"%s","cwd":"%s"}' "$(json_escape "$SESSION_KEY")" "$(json_escape "$PWD")")"
	if printf "%s" "$payload" | "$SIGNET_BIN" hook session-start -H codex --project "$PWD" > "$INSTRUCTIONS_FILE" 2>/dev/null; then
		if [ ! -s "$INSTRUCTIONS_FILE" ]; then
			rm -f "$INSTRUCTIONS_FILE"
			INSTRUCTIONS_FILE=""
		fi
	else
		rm -f "$INSTRUCTIONS_FILE"
		INSTRUCTIONS_FILE=""
	fi
}

find_session_file() {
	if [ ! -d "$SESSION_ROOT" ] || [ -z "$START_MARKER" ] || [ ! -f "$START_MARKER" ]; then
		return 0
	fi

	find "$SESSION_ROOT" -type f -name '*.jsonl' -newer "$START_MARKER" 2>/dev/null | sort | tail -n 1
}

session_end() {
	if [ -z "$SESSION_KEY" ]; then
		return 0
	fi

	TRANSCRIPT_PATH="$(find_session_file)"
	payload="$(printf '{"session_id":"%s","transcript_path":"%s","cwd":"%s"}' "$(json_escape "$SESSION_KEY")" "$(json_escape "$TRANSCRIPT_PATH")" "$(json_escape "$PWD")")"
	printf "%s" "$payload" | "$SIGNET_BIN" hook session-end -H codex >/dev/null 2>&1 || true
}

if [ "\${SIGNET_NO_HOOKS:-}" = "1" ] || [ "\${SIGNET_CODEX_BYPASS_WRAPPER:-}" = "1" ]; then
	exec "$REAL_CODEX_BIN" "$@"
fi

if [ ! -x "$REAL_CODEX_BIN" ]; then
	echo "[signet] codex wrapper could not find real binary at $REAL_CODEX_BIN" >&2
	exit 1
fi

trap 'cleanup' EXIT

session_start

set +e
if [ -n "$INSTRUCTIONS_FILE" ]; then
	"$REAL_CODEX_BIN" -c "model_instructions_file=$INSTRUCTIONS_FILE" "$@"
else
	"$REAL_CODEX_BIN" "$@"
fi
EXIT_CODE=$?
set -e

session_end
exit "$EXIT_CODE"
`;
}

/**
 * Build a Windows .cmd wrapper that mirrors the Unix shell wrapper above.
 *
 * Design notes:
 * - JSON payloads are built via PowerShell's ConvertTo-Json to safely escape
 *   special characters (", &, |, %) that would break raw cmd echo piping.
 * - Environment variables set with `set` inside `setlocal` are inherited by
 *   child PowerShell processes and accessed via $env: — this avoids double-
 *   expansion pitfalls in cmd's string interpolation.
 * - All PowerShell invocations use -NoProfile -ErrorAction SilentlyContinue
 *   to suppress stderr noise and prevent profile scripts from interfering.
 * - Session-start/end hooks match the Unix wrapper's behavior: generate a
 *   session key, capture model instructions, discover transcript files, and
 *   pass structured context to the signet daemon.
 */
function buildWindowsWrapper(realCodexBin: string): string {
	// Common PowerShell flags used across all invocations in the wrapper
	const psFlags = "-NoProfile -ErrorAction SilentlyContinue";

	return `@echo off
setlocal

set "REAL_CODEX_BIN=${realCodexBin}"
set "SIGNET_BIN=signet"
set "SESSION_ROOT=%USERPROFILE%\\.codex\\sessions"
set "SESSION_KEY="
set "INSTRUCTIONS_FILE="

if "%SIGNET_NO_HOOKS%"=="1" goto :run_direct
if "%SIGNET_CODEX_BYPASS_WRAPPER%"=="1" goto :run_direct

REM Generate a session key (GUID preferred, timestamp+random fallback)
for /f "tokens=*" %%i in ('powershell ${psFlags} -Command "[guid]::NewGuid().ToString()" 2^>nul') do set "SESSION_KEY=%%i"
if "%SESSION_KEY%"=="" (
	for /f "tokens=*" %%i in ('powershell ${psFlags} -Command "Get-Date -UFormat %%s" 2^>nul') do set "SESSION_KEY=codex-%%i-%RANDOM%"
)

REM Create temp directory for model instructions
set "TMP_ROOT=%TEMP%\\signet-codex-%RANDOM%"
mkdir "%TMP_ROOT%" >nul 2>&1
set "INSTRUCTIONS_FILE=%TMP_ROOT%\\model-instructions.md"

REM Session-start hook: build JSON via ConvertTo-Json for safe escaping of paths containing ", &, |, %
set "HOOK_OK=0"
for /f "delims=" %%j in ('powershell ${psFlags} -Command "ConvertTo-Json @{session_id=$env:SESSION_KEY;cwd=$PWD.Path} -Compress"') do (
	echo %%j| "%SIGNET_BIN%" hook session-start -H codex --project "%CD%" > "%INSTRUCTIONS_FILE%" 2>nul && set "HOOK_OK=1"
)
if "%HOOK_OK%"=="0" (
	set "INSTRUCTIONS_FILE="
) else (
	for %%A in ("%INSTRUCTIONS_FILE%") do if %%~zA==0 set "INSTRUCTIONS_FILE="
)

if defined INSTRUCTIONS_FILE (
	"%REAL_CODEX_BIN%" -c "model_instructions_file=%INSTRUCTIONS_FILE%" %*
) else (
	"%REAL_CODEX_BIN%" %*
)
set "EXIT_CODE=%ERRORLEVEL%"

REM Find newest transcript file created during this session
set "TRANSCRIPT_PATH="
if exist "%SESSION_ROOT%" (
	for /f "tokens=*" %%f in ('powershell ${psFlags} -Command "Get-ChildItem -Path \\"%SESSION_ROOT%\\" -Filter *.jsonl -Recurse | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName" 2^>nul') do set "TRANSCRIPT_PATH=%%f"
)

REM Session-end hook: same ConvertTo-Json approach for consistent safe escaping
for /f "delims=" %%j in ('powershell ${psFlags} -Command "ConvertTo-Json @{session_id=$env:SESSION_KEY;transcript_path=$env:TRANSCRIPT_PATH;cwd=$PWD.Path} -Compress"') do (
	echo %%j| "%SIGNET_BIN%" hook session-end -H codex >nul 2>&1
)

REM Cleanup temp directory
if exist "%TMP_ROOT%" rmdir /s /q "%TMP_ROOT%" >nul 2>&1

exit /b %EXIT_CODE%

:run_direct
"%REAL_CODEX_BIN%" %*
exit /b %ERRORLEVEL%
`;
}

export class CodexConnector extends BaseConnector {
	readonly name = "Codex";
	readonly harnessId = "codex";

	private getCodexHome(): string {
		return join(homedir(), ".codex");
	}

	private getWrapperDir(): string {
		return join(homedir(), ".config", "signet", "bin");
	}

	private getWrapperPath(): string {
		const name = process.platform === "win32" ? "codex.cmd" : "codex";
		return join(this.getWrapperDir(), name);
	}

	private getShellConfigPaths(): string[] {
		if (process.platform === "win32") return [];
		return [
			join(homedir(), ".zshrc"),
			join(homedir(), ".bashrc"),
			join(homedir(), ".bash_profile"),
		];
	}

	getConfigPath(): string {
		return join(this.getCodexHome(), "config.toml");
	}

	private resolveRealCodexBin(): string | null {
		const wrapperPath = this.getWrapperPath();
		const isWindows = process.platform === "win32";
		const locatorCmd = isWindows ? ["where", "codex"] : ["which", "-a", "codex"];
		const proc = Bun.spawnSync(locatorCmd, {
			stdout: "pipe",
			stderr: "pipe",
		});
		if (proc.exitCode !== 0) return null;

		const candidates = proc.stdout
			.toString()
			.split(/\r?\n/)
			.map((line: string) => line.trim())
			.filter((line: string) => line.length > 0);

		for (const candidate of candidates) {
			if (candidate !== wrapperPath) return candidate;
		}
		return null;
	}

	async install(basePath: string): Promise<InstallResult> {
		const filesWritten: string[] = [];
		const configsPatched: string[] = [];
		const isWindows = process.platform === "win32";

		const realCodexBin = this.resolveRealCodexBin();
		if (!realCodexBin) {
			throw new Error("Could not find Codex CLI on PATH");
		}

		const wrapperDir = this.getWrapperDir();
		mkdirSync(wrapperDir, { recursive: true });

		const wrapperPath = this.getWrapperPath();
		const wrapperContent = isWindows
			? buildWindowsWrapper(realCodexBin)
			: buildWrapper(realCodexBin);
		writeFileSync(wrapperPath, wrapperContent, isWindows ? {} : { mode: 0o755 });
		filesWritten.push(wrapperPath);

		for (const shellPath of this.getShellConfigPaths()) {
			const existing = existsSync(shellPath) ? readFileSync(shellPath, "utf-8") : "";
			const next = appendBlock(existing);
			if (next !== existing) {
				writeFileSync(shellPath, next);
				configsPatched.push(shellPath);
			}
		}

		return {
			success: true,
			message: "Codex integration installed successfully",
			filesWritten,
			configsPatched,
		};
	}

	async uninstall(): Promise<UninstallResult> {
		const filesRemoved: string[] = [];
		const configsPatched: string[] = [];

		const wrapperPath = this.getWrapperPath();
		if (existsSync(wrapperPath)) {
			rmSync(wrapperPath, { force: true });
			filesRemoved.push(wrapperPath);
		}

		for (const shellPath of this.getShellConfigPaths()) {
			if (!existsSync(shellPath)) continue;
			const existing = readFileSync(shellPath, "utf-8");
			const next = stripBlock(existing);
			if (next !== existing) {
				writeFileSync(shellPath, next);
				configsPatched.push(shellPath);
			}
		}

		return { filesRemoved, configsPatched };
	}

	isInstalled(): boolean {
		if (!existsSync(this.getWrapperPath())) return false;
		// On Windows there are no shell configs to patch
		if (process.platform === "win32") return true;
		return this.getShellConfigPaths().some((shellPath) => {
			if (!existsSync(shellPath)) return false;
			try {
				return readFileSync(shellPath, "utf-8").includes(SHELL_BLOCK_START);
			} catch {
				return false;
			}
		});
	}
}
