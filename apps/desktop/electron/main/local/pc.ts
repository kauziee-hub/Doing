import { execFile, spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';

/**
 * PC-wide actions for the Assistant (0.5.2): find files, open what was found, open installed
 * apps, media keys, a few settings, and WhatsApp drafts. Every action is fixed host code with
 * validated arguments; model text never becomes a command. Arguments reach PowerShell only as
 * JSON in an environment variable, never inside the script text.
 */
export interface FoundFile {
  path: string;
  size: number | null;
  modified: string | null;
}
export interface InstalledApp {
  name: string;
  id: string;
}
export type MediaCommand = 'play_pause' | 'next' | 'previous' | 'volume_up' | 'volume_down' | 'mute';
export type SettingsPage = keyof typeof SETTINGS_PAGES;

export interface PcHost {
  findFiles(query: string): Promise<FoundFile[]>;
  openPath(path: string): Promise<void>;
  revealPath(path: string): void;
  listApps(): Promise<InstalledApp[]>;
  launchApp(app: InstalledApp): Promise<void>;
  media(command: MediaCommand): Promise<void>;
  setVolume(level: number): Promise<number>;
  setBrightness(level: number): Promise<number>;
  setDarkMode(on: boolean): Promise<boolean>;
  openUri(uri: string): Promise<void>;
}

/** Settings pages Doing may open (the user changes them there). */
export const SETTINGS_PAGES = {
  display: 'ms-settings:display',
  sound: 'ms-settings:sound',
  bluetooth: 'ms-settings:bluetooth',
  wifi: 'ms-settings:network-wifi',
  network: 'ms-settings:network',
  notifications: 'ms-settings:notifications',
  focus: 'ms-settings:quiethours',
  battery: 'ms-settings:batterysaver',
  power: 'ms-settings:powersleep',
  apps: 'ms-settings:appsfeatures',
  default_apps: 'ms-settings:defaultapps',
  colors: 'ms-settings:personalization-colors',
  background: 'ms-settings:personalization-background',
  mouse: 'ms-settings:mousetouchpad',
  keyboard: 'ms-settings:typing',
  language: 'ms-settings:regionlanguage',
  date_time: 'ms-settings:dateandtime',
  storage: 'ms-settings:storagesense',
  windows_update: 'ms-settings:windowsupdate',
  about: 'ms-settings:about',
} as const;

/** Files Doing will not open (it can still show them in their folder). */
const EXECUTABLE = new Set(['.exe', '.com', '.bat', '.cmd', '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.msi', '.msp', '.scr', '.hta', '.cpl', '.lnk', '.url', '.reg', '.jar', '.appref-ms', '.application', '.gadget', '.pif', '.sys', '.dll']);
export function isExecutable(path: string): boolean {
  return EXECUTABLE.has(extname(path).toLowerCase());
}

/** Apps Doing won't open: shells and admin tools (a request like that is better done by hand). */
const ADMIN_APPS = /\b(?:powershell|command prompt|cmd|terminal|registry|regedit|task scheduler|group policy|services|computer management|disk management|windows tools|system configuration|security|defender|firewall|control panel|run)\b/i;

/** Search terms safe to place in a Windows Search query: letters, digits, space, dot, dash, underscore. */
export function searchTerms(query: string): string[] {
  return query
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N} ._-]/gu, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !/^(?:the|a|an|my|file|files|where|is|find|named|called|in|on|pc|computer|laptop|of|for)$/i.test(t))
    .slice(0, 4)
    .map((t) => t.slice(0, 40));
}

/**
 * A plain "find …" / "where is my … file" request, answered by searching without asking the model
 * first: the 4B model kept asking for a folder instead (measured 2026-11-27 on "find my resume").
 * Returns the search words, or null when the request isn't clearly about a file.
 */
export function directFind(text: string): string | null {
  const t = text.trim();
  const m = /^(?:please\s+|can you\s+|could you\s+)?(?:find|locate|search for|look for|where(?:'s| is| are| did i (?:save|put)))\s+(.+?)[?.!]*$/i.exec(t);
  if (!m) return null;
  const rest = m[1]!;
  if (/\b(?:and|then)\b/i.test(rest) && /\b(?:open|show|delete|move|send|play)\b/i.test(rest)) return searchTerms(rest.split(/\b(?:and|then)\b/i)[0]!).join(' ') || null;
  const fileish = /\b(?:files?|documents?|docs?|pdfs?|photos?|pictures?|images?|videos?|songs?|folders?|sheets?|spreadsheets?|presentations?|notes?|resume|résumé|cv|\w+\.\w{2,4})\b/i;
  if (!fileish.test(rest)) return null;
  const terms = searchTerms(rest.replace(/\b(?:files?|documents?|docs?|folders?)\b/gi, ' '));
  return terms.length ? terms.join(' ') : null;
}

/** "open spotify", "launch the calculator app": the app name, or null for anything that looks like a file or more. */
export function directOpen(text: string): string | null {
  const m = /^(?:please\s+)?(?:open|launch|start)\s+(?:the\s+|my\s+)?([\p{L}\p{N} .&'+-]{2,40}?)(?:\s+app)?[.!]*$/iu.exec(text.trim());
  if (!m || /\b(?:file|folder|document|website|site|page|link|tab)\b|\.\w{2,4}$/i.test(m[1]!)) return null;
  return m[1]!.trim();
}

const norm = (s: string) => s.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** The installed app a name refers to: exact, then starts-with, then contains. Several equally good matches are returned for the user to pick. */
export function matchApps(name: string, apps: InstalledApp[]): InstalledApp[] {
  const want = norm(name.replace(/\b(?:app|application|the)\b/gi, ''));
  if (!want) return [];
  const score = (a: InstalledApp) => {
    const n = norm(a.name);
    return n === want ? 3 : n.startsWith(want) ? 2 : n.includes(want) ? 1 : 0;
  };
  const scored = apps.map((a) => ({ a, s: score(a) })).filter((x) => x.s > 0);
  const best = Math.max(0, ...scored.map((x) => x.s));
  const top = scored.filter((x) => x.s === best).map((x) => x.a);
  return [...new Map(top.map((a) => [a.id, a])).values()].slice(0, 6);
}
export function isAdminApp(name: string): boolean {
  return ADMIN_APPS.test(name);
}

/** A WhatsApp draft link: digits only (country code first), text URL-encoded. Null when the number isn't plausible. */
export function whatsappUri(phone: string, text: string): string | null {
  const digits = phone.replace(/[\s()+-]/g, '');
  if (!/^\d{8,15}$/.test(digits)) return null;
  return `whatsapp://send?phone=${digits}&text=${encodeURIComponent(text)}`;
}

const MEDIA_KEYS: Record<MediaCommand, number> = { play_pause: 0xb3, next: 0xb0, previous: 0xb1, volume_up: 0xaf, volume_down: 0xae, mute: 0xad };

function powershell(script: string, arg: unknown, timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { env: { ...process.env, DOING_PC_ARG: JSON.stringify(arg ?? null) }, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 << 20 },
      (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).toString().trim().split('\n')[0]!.slice(0, 300))) : resolve(stdout.toString())),
    );
  });
}

const PS_FIND = `$ErrorActionPreference='Stop'
$a = $env:DOING_PC_ARG | ConvertFrom-Json
$where = (@($a.terms) | ForEach-Object { "System.FileName LIKE '%" + $_ + "%'" }) -join ' AND '
$c = New-Object -ComObject ADODB.Connection
$c.Open("Provider=Search.CollatorDSO;Extended Properties='Application=Windows';")
$rs = New-Object -ComObject ADODB.Recordset
$rs.Open("SELECT TOP 40 System.ItemPathDisplay, System.Size, System.DateModified FROM SystemIndex WHERE " + $where + " AND SCOPE='file:' ORDER BY System.DateModified DESC", $c)
$out = @()
while (-not $rs.EOF) { $out += [pscustomobject]@{ path = [string]$rs.Fields.Item('System.ItemPathDisplay').Value; size = $rs.Fields.Item('System.Size').Value; modified = [string]$rs.Fields.Item('System.DateModified').Value }; $rs.MoveNext() }
ConvertTo-Json -InputObject @($out) -Compress`;

const PS_APPS = `Get-StartApps | Select-Object Name, AppID | ConvertTo-Json -Compress`;

const PS_KEY = `$a = $env:DOING_PC_ARG | ConvertFrom-Json
Add-Type -Name K -Namespace DoingKeys -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte v, byte s, uint f, System.UIntPtr e);'
for ($i = 0; $i -lt [int]$a.times; $i++) { [DoingKeys.K]::keybd_event([byte]$a.vk, 0, 1, [UIntPtr]::Zero); [DoingKeys.K]::keybd_event([byte]$a.vk, 0, 3, [UIntPtr]::Zero) }`;

const PS_VOLUME = `$ErrorActionPreference='Stop'
$a = $env:DOING_PC_ARG | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume { int f(); int g(); int h(); int i(); int SetMasterVolumeLevelScalar(float level, Guid ctx); int j(); int GetMasterVolumeLevelScalar(out float level); int k(); int l(); int m(); int n(); int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, Guid ctx); int GetMute(out bool mute); }
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid id, int ctx, int p, out IAudioEndpointVolume v); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice d); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator { }
public static class DoingAudio {
  static IAudioEndpointVolume V() { var e = (IMMDeviceEnumerator)new MMDeviceEnumerator(); IMMDevice d; Marshal.ThrowExceptionForHR(e.GetDefaultAudioEndpoint(0, 1, out d)); var id = typeof(IAudioEndpointVolume).GUID; IAudioEndpointVolume v; Marshal.ThrowExceptionForHR(d.Activate(ref id, 23, 0, out v)); return v; }
  public static float Set(float level) { var v = V(); Marshal.ThrowExceptionForHR(v.SetMute(false, Guid.Empty)); Marshal.ThrowExceptionForHR(v.SetMasterVolumeLevelScalar(level, Guid.Empty)); float now; Marshal.ThrowExceptionForHR(v.GetMasterVolumeLevelScalar(out now)); return now; }
}
'@
[math]::Round([DoingAudio]::Set([float]([int]$a.level / 100.0)) * 100)`;

const PS_BRIGHTNESS = `$ErrorActionPreference='Stop'
$a = $env:DOING_PC_ARG | ConvertFrom-Json
$m = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods
Invoke-CimMethod -InputObject $m -MethodName WmiSetBrightness -Arguments @{ Timeout = 1; Brightness = [byte]$a.level } | Out-Null
Start-Sleep -Milliseconds 400
(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness | Select-Object -First 1).CurrentBrightness`;

const PS_DARK = `$ErrorActionPreference='Stop'
$a = $env:DOING_PC_ARG | ConvertFrom-Json
$k = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize'
$light = if ($a.on) { 0 } else { 1 }
Set-ItemProperty -Path $k -Name AppsUseLightTheme -Value $light -Type DWord
Set-ItemProperty -Path $k -Name SystemUsesLightTheme -Value $light -Type DWord
Add-Type -Name B -Namespace DoingTheme -MemberDefinition '[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, UIntPtr w, string l, uint f, uint t, out UIntPtr r);'
$r = [UIntPtr]::Zero
[DoingTheme.B]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'ImmersiveColorSet', 2, 2000, [ref]$r) | Out-Null
(Get-ItemProperty -Path $k).AppsUseLightTheme`;

/** Folders searched by hand when Windows Search has nothing (or is off). */
function walkRoots(): string[] {
  const home = homedir();
  return ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Music', 'Videos', 'OneDrive'].map((d) => join(home, d));
}
/** App data and developer folders: never what someone means by "my resume". */
const NOISE = /\\(?:AppData|\$Recycle\.Bin|node_modules|\.git|__pycache__|site-packages|\.venv|venv|\.next|\.nuxt|\.gradle|\.m2|\.cargo|\.rustup|\.cache)(?:\\|$)/i;
const SKIP_DIRS = /^(?:node_modules|\.git|\.cache|AppData|\$Recycle\.Bin|Windows|Program Files.*|ProgramData)$/i;

async function walkFind(terms: string[], budgetMs = 4000, limit = 40): Promise<FoundFile[]> {
  const want = terms.map((t) => t.toLocaleLowerCase());
  const out: FoundFile[] = [];
  const deadline = Date.now() + budgetMs;
  const queue: Array<{ dir: string; depth: number }> = walkRoots().map((dir) => ({ dir, depth: 0 }));
  while (queue.length && out.length < limit && Date.now() < deadline) {
    const { dir, depth } = queue.shift()!;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 7 && !SKIP_DIRS.test(e.name) && !e.name.startsWith('.')) queue.push({ dir: full, depth: depth + 1 });
      }
      const lower = e.name.toLocaleLowerCase();
      if (want.every((t) => lower.includes(t))) {
        const s = await stat(full).catch(() => null);
        out.push({ path: full, size: s?.isFile() ? s.size : null, modified: s ? s.mtime.toISOString() : null });
        if (out.length >= limit) break;
      }
    }
  }
  return out;
}

export function createPcHost(deps: { openPath: (p: string) => Promise<string>; showItemInFolder: (p: string) => void; openExternal: (uri: string) => Promise<void> }): PcHost {
  let appsCache: { at: number; apps: InstalledApp[] } | null = null;
  return {
    async findFiles(query) {
      const terms = searchTerms(query);
      if (!terms.length) return [];
      const indexed = await powershell(PS_FIND, { terms })
        .then((s) => (JSON.parse(s || '[]') as FoundFile[]).filter((f) => f.path))
        .catch(() => [] as FoundFile[]);
      // Windows Search covers indexed places in about a second; walk the usual folders only when it finds nothing.
      const extra = indexed.length ? [] : await walkFind(terms);
      const seen = new Set<string>();
      return [...indexed, ...extra]
        .filter((f) => !NOISE.test(f.path) && !seen.has(f.path.toLowerCase()) && seen.add(f.path.toLowerCase()))
        .slice(0, 20);
    },
    async openPath(path) {
      const error = await deps.openPath(path);
      if (error) throw new Error(error);
    },
    revealPath(path) {
      deps.showItemInFolder(path);
    },
    async listApps() {
      if (appsCache && Date.now() - appsCache.at < 5 * 60_000) return appsCache.apps;
      const raw = JSON.parse((await powershell(PS_APPS, null)) || '[]') as Array<{ Name: string; AppID: string }> | { Name: string; AppID: string };
      const apps = (Array.isArray(raw) ? raw : [raw]).filter((a) => a?.Name && a.AppID).map((a) => ({ name: a.Name, id: a.AppID }));
      appsCache = { at: Date.now(), apps };
      return apps;
    },
    async launchApp(app) {
      await new Promise<void>((resolve, reject) => {
        const child = spawn('explorer.exe', [`shell:AppsFolder\\${app.id}`], { detached: true, stdio: 'ignore', windowsHide: true });
        child.once('error', reject);
        child.once('spawn', () => {
          child.unref();
          resolve();
        });
      });
    },
    async media(command) {
      const vk = MEDIA_KEYS[command];
      await powershell(PS_KEY, { vk, times: command === 'volume_up' || command === 'volume_down' ? 5 : 1 });
    },
    async setVolume(level) {
      return Number((await powershell(PS_VOLUME, { level: Math.round(level) })).trim());
    },
    async setBrightness(level) {
      return Number((await powershell(PS_BRIGHTNESS, { level: Math.round(level) })).trim());
    },
    async setDarkMode(on) {
      return (await powershell(PS_DARK, { on })).trim() === '0';
    },
    async openUri(uri) {
      if (!/^(?:ms-settings:[a-z-]+|whatsapp:\/\/send\?|spotify:search:|https:\/\/open\.spotify\.com\/search\/)/.test(uri)) throw new Error('That link type is not allowed.');
      await deps.openExternal(uri);
    },
  };
}
