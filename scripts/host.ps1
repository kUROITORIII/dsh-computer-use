$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

# The protocol is UTF-8 in both directions regardless of the console code page:
# Node writes UTF-8, and window titles or typed text may be non-ASCII.
$utf8 = [System.Text.UTF8Encoding]::new($false)
$script:stdinReader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8)
$script:stdoutWriter = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$script:stdoutWriter.AutoFlush = $true

# The user's pause switch. It lives here, next to the code that actually sends
# the input, because "stop touching my computer" has to hold even if the caller
# forgets to ask: every acting operation checks it and refuses before it moves
# anything. Only the pause operation itself and the read-only operations pass.
$script:paused = $false

$script:dshSource = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class DshWin
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int left; public int top; public int right; public int bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int x; public int y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

    [StructLayout(LayoutKind.Sequential)]
    public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }

    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public INPUTUNION u; }

    public class WindowInfo
    {
        public long handle { get; set; }
        public string title { get; set; }
        public uint pid { get; set; }
        public string process { get; set; }
        public int x { get; set; }
        public int y { get; set; }
        public int width { get; set; }
        public int height { get; set; }
        public bool active { get; set; }
    }

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool join);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern IntPtr SetActiveWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint mapType);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, uint data, IntPtr extra);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern short VkKeyScan(char ch);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll", SetLastError = true)] public static extern int GetWindowLong(IntPtr hWnd, int index);
    [DllImport("user32.dll", SetLastError = true)] public static extern int SetWindowLong(IntPtr hWnd, int index, int value);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out RECT value, int size);

    /// <summary>
    /// Push the docked panel behind everything (or bring it back on top) for the
    /// moment a click has to reach the window underneath it.
    /// WS_EX_TRANSPARENT only affects hit testing on layered windows, and an
    /// Electron main window is not layered, so z-order is what actually works.
    /// </summary>
    public static bool SetPanelAway(long handle, bool away)
    {
        IntPtr h = new IntPtr(handle);
        if (!IsWindow(h)) return false;
        IntPtr after = away ? new IntPtr(1) : new IntPtr(-1); // HWND_BOTTOM : HWND_TOPMOST
        return SetWindowPos(h, after, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010);
    }

    /// <summary>
    /// Top-level window that owns one screen point, so the caller can tell whether
    /// the docked panel is what lies under the pointer.
    /// </summary>
    public static long RootAt(int x, int y)
    {
        POINT point = new POINT();
        point.x = x;
        point.y = y;
        IntPtr window = WindowFromPoint(point);
        if (window == IntPtr.Zero) return 0;
        IntPtr root = GetAncestor(window, 2); // GA_ROOT
        return (root == IntPtr.Zero ? window : root).ToInt64();
    }

    public static int[] VisibleRectOf(long handle)
    {
        RECT rect;
        try
        {
            // DWMWA_EXTENDED_FRAME_BOUNDS ignores the invisible resize border that
            // GetWindowRect includes, so an overlay drawn from this rect hugs the
            // pixels the user actually sees.
            int status = DwmGetWindowAttribute(new IntPtr(handle), 9, out rect, Marshal.SizeOf(typeof(RECT)));
            if (status == 0 && rect.right - rect.left > 4 && rect.bottom - rect.top > 4)
            {
                return new int[] { rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top };
            }
        }
        catch (Exception)
        {
        }
        return WindowRectOf(handle);
    }

    public static int[] WindowRectOf(long handle)
    {
        RECT rect;
        if (!GetWindowRect(new IntPtr(handle), out rect)) return null;
        return new int[] { rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top };
    }

    public static string InitDpi()
    {
        try
        {
            if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return "per-monitor-v2";
        }
        catch (Exception) { }
        try
        {
            if (SetProcessDPIAware()) return "system";
        }
        catch (Exception) { }
        return "none";
    }

    public static bool MoveAbs(int x, int y)
    {
        int vx = GetSystemMetrics(76);
        int vy = GetSystemMetrics(77);
        int vw = GetSystemMetrics(78);
        int vh = GetSystemMetrics(79);
        if (vw <= 0 || vh <= 0) { vx = 0; vy = 0; vw = GetSystemMetrics(0); vh = GetSystemMetrics(1); }
        double nx = (x - vx) * 65535.0 / Math.Max(1, vw - 1);
        double ny = (y - vy) * 65535.0 / Math.Max(1, vh - 1);
        INPUT input = new INPUT();
        input.type = 0;
        input.u.mi.dx = (int)Math.Round(nx);
        input.u.mi.dy = (int)Math.Round(ny);
        input.u.mi.mouseData = 0;
        input.u.mi.dwFlags = 0x0001 | 0x8000 | 0x4000;
        input.u.mi.time = 0;
        input.u.mi.dwExtraInfo = IntPtr.Zero;
        uint sent = SendInput(1, new INPUT[] { input }, Marshal.SizeOf(typeof(INPUT)));
        if (sent != 1) SetCursorPos(x, y);
        return true;
    }

    public static void Button(uint flags)
    {
        mouse_event(flags, 0, 0, 0, IntPtr.Zero);
    }

    public static void Wheel(int delta)
    {
        mouse_event(0x0800, 0, 0, unchecked((uint)delta), IntPtr.Zero);
    }

    public static void HScroll(int delta)
    {
        mouse_event(0x1000, 0, 0, unchecked((uint)delta), IntPtr.Zero);
    }

    public static void Key(ushort vk, bool up, bool extended)
    {
        // Send by scan code whenever one is known. A pure virtual-key event carries
        // wScan = 0, and applications that translate events themselves (Blender and
        // other OpenGL apps) then lose the modifier: Shift+A arrived as plain A,
        // which made every modified shortcut act like its unmodified twin.
        INPUT input = new INPUT();
        input.type = 1;
        uint scan = MapVirtualKey(vk, 0);
        if (scan != 0)
        {
            input.u.ki.wVk = 0;
            input.u.ki.wScan = (ushort)scan;
            input.u.ki.dwFlags = (uint)(0x0008 | (up ? 0x0002 : 0) | (extended ? 0x0001 : 0));
        }
        else
        {
            input.u.ki.wVk = vk;
            input.u.ki.wScan = 0;
            input.u.ki.dwFlags = (uint)((up ? 0x0002 : 0) | (extended ? 0x0001 : 0));
        }
        input.u.ki.time = 0;
        input.u.ki.dwExtraInfo = IntPtr.Zero;
        SendInput(1, new INPUT[] { input }, Marshal.SizeOf(typeof(INPUT)));
    }

    public static int CursorX() { POINT p; GetCursorPos(out p); return p.x; }
    public static int CursorY() { POINT p; GetCursorPos(out p); return p.y; }

    public static long Foreground() { return GetForegroundWindow().ToInt64(); }

    public static string WindowTitle(long handle)
    {
        IntPtr h = new IntPtr(handle);
        int len = GetWindowTextLength(h);
        if (len <= 0) return "";
        StringBuilder sb = new StringBuilder(len + 2);
        GetWindowText(h, sb, sb.Capacity);
        return sb.ToString();
    }

    public static string WindowProcess(long handle)
    {
        uint pid;
        GetWindowThreadProcessId(new IntPtr(handle), out pid);
        try { return Process.GetProcessById((int)pid).ProcessName; } catch (Exception) { return ""; }
    }

    public static uint WindowPid(long handle)
    {
        uint pid;
        GetWindowThreadProcessId(new IntPtr(handle), out pid);
        return pid;
    }

    public static bool Focus(long handle)
    {
        IntPtr h = new IntPtr(handle);
        if (!IsWindow(h)) return false;
        if (IsIconic(h)) ShowWindow(h, 9);

        IntPtr foreground = GetForegroundWindow();
        if (foreground == h) return true;

        // Windows refuses SetForegroundWindow from a process that is not in front
        // and has no recent input. A synthetic Alt press relaxes that lock.
        PressAlt();
        if (SetForegroundWindow(h) && GetForegroundWindow() == h) return true;

        // Attach to the foreground thread so this thread is allowed to switch.
        uint targetPid;
        uint targetThread = GetWindowThreadProcessId(foreground, out targetPid);
        uint ownThread = GetCurrentThreadId();
        if (targetThread != 0 && targetThread != ownThread)
        {
            if (AttachThreadInput(ownThread, targetThread, true))
            {
                try
                {
                    BringWindowToTop(h);
                    SetActiveWindow(h);
                    SetForegroundWindow(h);
                }
                finally
                {
                    AttachThreadInput(ownThread, targetThread, false);
                }
            }
        }
        if (GetForegroundWindow() == h) return true;

        // Last resort: raise the window without clicking it. Clicking the title
        // bar used to activate the window, but two actions in a row turned that
        // into a double click, which toggles maximise and leaves the user's
        // window resized behind their back.
        BringWindowToTop(h);
        if (GetForegroundWindow() == h) return true;
        SetForegroundWindow(h);
        return GetForegroundWindow() == h;
    }

    private static void PressAlt()
    {
        keybd_event(0x12, 0, 0, UIntPtr.Zero);
        keybd_event(0x12, 0, 2, UIntPtr.Zero);
        System.Threading.Thread.Sleep(20);
    }

    /** Largest visible top-level window owned by one process. */
    public static long MainWindowOf(int pid)
    {
        long best = 0;
        long bestArea = 0;
        EnumWindows(delegate(IntPtr h, IntPtr lparam)
        {
            if (!IsWindowVisible(h)) return true;
            uint owner;
            GetWindowThreadProcessId(h, out owner);
            if ((int)owner != pid) return true;
            RECT r;
            if (!GetWindowRect(h, out r)) return true;
            long area = (long)(r.right - r.left) * (r.bottom - r.top);
            if (area > bestArea && (r.right - r.left) > 240 && (r.bottom - r.top) > 160)
            {
                bestArea = area;
                best = h.ToInt64();
            }
            return true;
        }, IntPtr.Zero);
        return best;
    }

    /** Window bounds as x, y, width, height. */
    public static int[] RectOf(long handle)
    {
        RECT r;
        if (!GetWindowRect(new IntPtr(handle), out r)) return null;
        int[] box = new int[] { r.left, r.top, r.right - r.left, r.bottom - r.top };
        return box;
    }

    public static List<WindowInfo> ListWindows()
    {
        List<WindowInfo> list = new List<WindowInfo>();
        IntPtr fg = GetForegroundWindow();
        EnumWindows(delegate(IntPtr h, IntPtr lparam)
        {
            if (!IsWindowVisible(h)) return true;
            int len = GetWindowTextLength(h);
            if (len <= 0) return true;
            StringBuilder sb = new StringBuilder(len + 2);
            GetWindowText(h, sb, sb.Capacity);
            string title = sb.ToString();
            if (title.Length == 0) return true;
            RECT r;
            if (!GetWindowRect(h, out r)) return true;
            int w = r.right - r.left;
            int ht = r.bottom - r.top;
            if (w <= 0 || ht <= 0) return true;
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            string proc = "";
            try { proc = Process.GetProcessById((int)pid).ProcessName; } catch (Exception) { }
            WindowInfo info = new WindowInfo();
            info.handle = h.ToInt64();
            info.title = title;
            info.pid = pid;
            info.process = proc;
            info.x = r.left;
            info.y = r.top;
            info.width = w;
            info.height = ht;
            info.active = (h == fg);
            list.Add(info);
            return true;
        }, IntPtr.Zero);
        return list;
    }
}
'@

Add-Type -TypeDefinition $script:dshSource -Language CSharp | Out-Null

$dpiMode = [DshWin]::InitDpi()
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms | Out-Null

$script:extendedKeys = @(33, 34, 35, 36, 37, 38, 39, 40, 45, 46)

$script:vkMap = @{
    'backspace' = 8; 'tab' = 9; 'enter' = 13; 'return' = 13; 'shift' = 16; 'ctrl' = 17; 'control' = 17;
    'alt' = 18; 'menu' = 18; 'pause' = 19; 'break' = 19; 'capslock' = 20; 'esc' = 27; 'escape' = 27;
    'space' = 32; 'pageup' = 33; 'pgup' = 33; 'pagedown' = 34; 'pgdn' = 34; 'end' = 35; 'home' = 36;
    'left' = 37; 'up' = 38; 'right' = 39; 'down' = 40; 'insert' = 45; 'ins' = 45; 'delete' = 46; 'del' = 46;
    'lwin' = 91; 'win' = 91; 'rwin' = 92; 'apps' = 93; 'sleep' = 95; 'numlock' = 144; 'scrolllock' = 145;
    'prtsc' = 44; 'printscreen' = 44; 'semicolon' = 186; 'equals' = 187; 'comma' = 188; 'minus' = 189;
    'period' = 190; 'slash' = 191; 'grave' = 192; 'backslash' = 220; 'lbracket' = 219; 'rbracket' = 221; 'quote' = 222;
}
for ($i = 1; $i -le 24; $i++) { $script:vkMap["f$i"] = 111 + $i }
for ($c = 97; $c -le 122; $c++) { $script:vkMap[[string][char]$c] = $c - 32 }
for ($c = 48; $c -le 57; $c++) { $script:vkMap[[string][char]$c] = $c }

function Resolve-Key([string]$name) {
    $key = $name.Trim().ToLowerInvariant()
    if ($key.Length -eq 0) { throw "empty key name" }
    if ($script:vkMap.ContainsKey($key)) { return @{ vk = [int]$script:vkMap[$key]; shift = $false } }
    if ($key.Length -eq 1) {
        $ch = [char]$key
        $scanValue = [DshWin]::VkKeyScan($ch)
        if ($scanValue -lt 0) { throw "cannot map character '$key' to a virtual key" }
        $vk = $scanValue -band 0xFF
        return @{ vk = [int]$vk; shift = (($scanValue -shr 8) -band 1) -eq 1 }
    }
    throw "unknown key name '$name'"
}

function Send-KeyPress([string]$spec, [int]$repeat = 1) {
    if ($repeat -lt 1) { $repeat = 1 }
    if ($repeat -gt 20) { $repeat = 20 }
    $parts = $spec -split '\+'
    $mods = @()
    $target = $null
    for ($i = 0; $i -lt $parts.Length; $i++) {
        $piece = $parts[$i].Trim()
        if ($piece.Length -eq 0) { continue }
        if ($i -lt ($parts.Length - 1)) {
            $lower = $piece.ToLowerInvariant()
            if (@('ctrl', 'control', 'shift', 'alt', 'win', 'lwin', 'rwin') -contains $lower) {
                $mods += (Resolve-Key $piece)
                continue
            }
        }
        if ($null -ne $target) { throw "key specification '$spec' names more than one key" }
        $target = Resolve-Key $piece
    }
    if ($null -eq $target) { throw "key specification '$spec' names no key" }

    $modVks = @($mods | ForEach-Object { [int]$_.vk })
    $shiftInMods = $false
    foreach ($m in $mods) { if ([int]$m.vk -eq 16) { $shiftInMods = $true } }

    for ($r = 0; $r -lt $repeat; $r++) {
        foreach ($vk in $modVks) { [DshWin]::Key([uint16]$vk, $false, $false); Start-Sleep -Milliseconds 8 }
        $needShift = $target.shift -and -not $shiftInMods
        if ($needShift) { [DshWin]::Key([uint16]16, $false, $false); Start-Sleep -Milliseconds 8 }
        $targetVk = [int]$target.vk
        $isExtended = $script:extendedKeys -contains $targetVk
        [DshWin]::Key([uint16]$targetVk, $false, $isExtended)
        Start-Sleep -Milliseconds 12
        [DshWin]::Key([uint16]$targetVk, $true, $isExtended)
        if ($needShift) { [DshWin]::Key([uint16]16, $true, $false); Start-Sleep -Milliseconds 8 }
        for ($m = $modVks.Count - 1; $m -ge 0; $m--) { [DshWin]::Key([uint16]$modVks[$m], $true, $false); Start-Sleep -Milliseconds 8 }
        if ($r -lt ($repeat - 1)) { Start-Sleep -Milliseconds 40 }
    }
}

function Set-ClipboardText([string]$text) {
    $attempt = 0
    while ($attempt -lt 6) {
        try {
            [System.Windows.Forms.Clipboard]::SetText($text)
            return
        } catch {
            $attempt++
            Start-Sleep -Milliseconds 60
        }
    }
    throw "could not write text to the Windows clipboard"
}

function Get-ClipboardTextSafe() {
    try {
        if ([System.Windows.Forms.Clipboard]::ContainsText()) { return [System.Windows.Forms.Clipboard]::GetText() }
    } catch { }
    return $null
}

function Get-Monitors {
    $list = @()
    $screens = [System.Windows.Forms.Screen]::AllScreens
    for ($i = 0; $i -lt $screens.Count; $i++) {
        $s = $screens[$i]
        $list += [ordered]@{
            index = $i + 1
            primary = [bool]$s.Primary
            deviceName = $s.DeviceName
            x = $s.Bounds.X
            y = $s.Bounds.Y
            width = $s.Bounds.Width
            height = $s.Bounds.Height
        }
    }
    return , $list
}

function Get-ProcessNameForWindow([long]$handle) {
    try {
        $pidValue = [DshWin]::WindowPid($handle)
        if ($pidValue -le 0) { return '' }
        return (Get-Process -Id ([int]$pidValue) -ErrorAction Stop).ProcessName
    } catch {
        return ''
    }
}

# ---------------------------------------------------------------------------
# Region capture
#
# Both computer_zoom and computer_ocr need one thing the whole-screen capture
# never did: a piece of the screen at native resolution. They share the source
# grab below so a zoomed window is still read through PrintWindow (an occluded
# window must zoom correctly too) and a zoomed monitor still has our own panel
# painted out of it.
# ---------------------------------------------------------------------------

function Get-SourceBitmap($argsIn) {
    $handle = 0
    if ($null -ne $argsIn.handle) { $handle = [long]$argsIn.handle }
    if ($handle -ne 0) {
        $box = [DshWin]::VisibleRectOf($handle)
        if ($null -eq $box) { throw "window $handle no longer exists" }
        $windowX = [int]$box[0]
        $windowY = [int]$box[1]
        $width = [int]$box[2]
        $height = [int]$box[3]
        if ($width -lt 8 -or $height -lt 8) { throw "window $handle is minimized or has no drawable area" }
        $bitmap = New-Object System.Drawing.Bitmap $width, $height
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $hdc = $graphics.GetHdc()
        try {
            $printed = [DshWin]::PrintWindow([IntPtr]$handle, $hdc, 2)
        } finally {
            $graphics.ReleaseHdc($hdc)
            $graphics.Dispose()
        }
        if (-not $printed) {
            $copy = [System.Drawing.Graphics]::FromImage($bitmap)
            try {
                $copy.CopyFromScreen($windowX, $windowY, 0, 0, $bitmap.Size)
            } finally {
                $copy.Dispose()
            }
        }
        return [ordered]@{
            bitmap  = $bitmap
            x       = $windowX
            y       = $windowY
            width   = $width
            height  = $height
            kind    = 'window'
            handle  = $handle
            title   = [DshWin]::WindowTitle($handle)
            process = (Get-ProcessNameForWindow $handle)
            printed = [bool]$printed
        }
    }

    $monitor = 1
    if ($null -ne $argsIn.monitor) { $monitor = [int]$argsIn.monitor }
    $screens = [System.Windows.Forms.Screen]::AllScreens
    if ($monitor -lt 1 -or $monitor -gt $screens.Count) { throw "monitor $monitor is outside 1..$($screens.Count)" }
    $bounds = $screens[$monitor - 1].Bounds
    $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bitmap.Size)
    } finally {
        $graphics.Dispose()
    }
    $maskList = @()
    if ($null -ne $argsIn.masks) { $maskList = @($argsIn.masks) }
    if ($maskList.Count -gt 0) {
        $fill = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 24, 26, 30))
        $maskGraphics = [System.Drawing.Graphics]::FromImage($bitmap)
        try {
            foreach ($mask in $maskList) {
                if ($null -eq $mask) { continue }
                $maskWidth = [int]$mask.width
                $maskHeight = [int]$mask.height
                if ($maskWidth -le 0 -or $maskHeight -le 0) { continue }
                $maskGraphics.FillRectangle($fill, ([int]$mask.x - $bounds.X), ([int]$mask.y - $bounds.Y), $maskWidth, $maskHeight)
            }
        } finally {
            $maskGraphics.Dispose()
            $fill.Dispose()
        }
    }
    return [ordered]@{
        bitmap  = $bitmap
        x       = $bounds.X
        y       = $bounds.Y
        width   = $bounds.Width
        height  = $bounds.Height
        kind    = 'screen'
        monitor = $monitor
    }
}

# Cut one rectangle out of a source grab. The rectangle is given in physical
# screen pixels, which is the only space both a monitor and a window share, and
# the result keeps the absolute origin so callers can report screen coordinates.
function Get-CroppedBitmap($source, [int]$screenX, [int]$screenY, [int]$regionWidth, [int]$regionHeight) {
    $localX = $screenX - [int]$source.x
    $localY = $screenY - [int]$source.y
    if ($localX -lt 0) { $regionWidth = $regionWidth + $localX; $localX = 0 }
    if ($localY -lt 0) { $regionHeight = $regionHeight + $localY; $localY = 0 }
    $sourceWidth = [int]$source.width
    $sourceHeight = [int]$source.height
    if (($localX + $regionWidth) -gt $sourceWidth) { $regionWidth = $sourceWidth - $localX }
    if (($localY + $regionHeight) -gt $sourceHeight) { $regionHeight = $sourceHeight - $localY }
    if ($regionWidth -lt 8 -or $regionHeight -lt 8) {
        throw "the region does not overlap the captured area"
    }
    $rect = New-Object System.Drawing.Rectangle $localX, $localY, $regionWidth, $regionHeight
    $cropped = $source.bitmap.Clone($rect, $source.bitmap.PixelFormat)
    return [ordered]@{
        bitmap  = $cropped
        x       = ([int]$source.x + $localX)
        y       = ([int]$source.y + $localY)
        width   = $regionWidth
        height  = $regionHeight
    }
}

function Save-BitmapPng($bitmap, [string]$outPath) {
    $directory = [System.IO.Path]::GetDirectoryName($outPath)
    if ($directory -and -not (Test-Path -LiteralPath $directory)) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
    $bitmap.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
}

# computer_zoom: one rectangle of the screen (or of a window) at native
# resolution. Only a region wider than maxWidth is scaled, and by then it is
# usually a narrow strip, so the text inside it stays legible.
function Invoke-ZoomShot($argsIn) {
    if ([string]::IsNullOrWhiteSpace([string]$argsIn.outPath)) { throw "zoom needs an output path" }
    $maxWidth = 1600
    if ($null -ne $argsIn.maxWidth) { $maxWidth = [int]$argsIn.maxWidth }
    $source = Get-SourceBitmap $argsIn
    $cropped = $null
    $output = $null
    try {
        $cropped = Get-CroppedBitmap $source ([int]$argsIn.x) ([int]$argsIn.y) ([int]$argsIn.width) ([int]$argsIn.height)
        $output = $cropped.bitmap
        $imageWidth = [int]$cropped.width
        $imageHeight = [int]$cropped.height
        if ($maxWidth -gt 0 -and $imageWidth -gt $maxWidth) {
            $scale = $maxWidth / $imageWidth
            $imageWidth = [int][Math]::Round($cropped.width * $scale)
            $imageHeight = [int][Math]::Round($cropped.height * $scale)
            $resized = New-Object System.Drawing.Bitmap $imageWidth, $imageHeight
            $resizeGraphics = [System.Drawing.Graphics]::FromImage($resized)
            try {
                $resizeGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                $resizeGraphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
                $resizeGraphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
                $resizeGraphics.DrawImage($cropped.bitmap, 0, 0, $imageWidth, $imageHeight)
            } finally {
                $resizeGraphics.Dispose()
            }
            $output = $resized
        }
        Save-BitmapPng $output ([string]$argsIn.outPath)
    } finally {
        if ($null -ne $cropped -and $null -ne $cropped.bitmap -and $cropped.bitmap -ne $output) { $cropped.bitmap.Dispose() }
        if ($null -ne $output) { $output.Dispose() }
        $source.bitmap.Dispose()
    }
    return [ordered]@{
        path        = [string]$argsIn.outPath
        kind        = $source.kind
        handle      = $(if ($null -ne $source.handle) { $source.handle } else { 0 })
        title       = $(if ($null -ne $source.title) { $source.title } else { '' })
        process     = $(if ($null -ne $source.process) { $source.process } else { '' })
        monitor     = $(if ($null -ne $source.monitor) { $source.monitor } else { 0 })
        x           = $cropped.x
        y           = $cropped.y
        width       = $cropped.width
        height      = $cropped.height
        imageWidth  = $imageWidth
        imageHeight = $imageHeight
        sourceX     = $source.x
        sourceY     = $source.y
        sourceWidth = $source.width
        sourceHeight = $source.height
        # A zoom is still a look at the desktop, so the pointer and the foreground
        # window belong in its answer: the model decides what to do next from them.
        cursor      = [ordered]@{ x = [DshWin]::CursorX(); y = [DshWin]::CursorY() }
        activeWindow = [ordered]@{
            handle  = [DshWin]::Foreground()
            title   = [DshWin]::WindowTitle([DshWin]::Foreground())
            process = (Get-ProcessNameForWindow ([DshWin]::Foreground()))
        }
        capturedAt  = [DateTime]::UtcNow.ToString('o')
    }
}

# ---------------------------------------------------------------------------
# OCR (Windows.Media.Ocr)
#
# UIA tells us nothing for a canvas, a game, or a GPU-rendered editor, and a
# screenshot there costs ~1.8k tokens to say "some text". The OS OCR engine
# reads the same pixels for a few hundred tokens, but it is only ever a
# fallback: it returns text, not roles, so nothing here may be preferred over a
# control tree.
# ---------------------------------------------------------------------------

$script:OcrAsTask = $null
$script:OcrEngine = $null
$script:OcrEngineTag = ''

function Get-OcrAsTaskMethod {
    if ($null -ne $script:OcrAsTask) { return $script:OcrAsTask }
    Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop
    $script:OcrAsTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
            $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
            $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
        })[0]
    if ($null -eq $script:OcrAsTask) { throw 'this PowerShell cannot await WinRT operations' }
    return $script:OcrAsTask
}

function Wait-WinRt($operation, $resultType) {
    $method = Get-OcrAsTaskMethod
    $task = $method.MakeGenericMethod($resultType).Invoke($null, @($operation))
    try {
        $finished = $task.Wait(20000)
    } catch {
        throw ("WinRT 调用失败：" + $_.Exception.GetBaseException().Message)
    }
    if (-not $finished) { throw 'the OCR engine did not answer within 20 s' }
    return $task.Result
}

function Get-OcrEngine([string]$tag) {
    $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
    if ([string]::IsNullOrWhiteSpace($tag)) {
        if ($null -ne $script:OcrEngine -and $script:OcrEngineTag -eq '') { return $script:OcrEngine }
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    } else {
        if ($null -ne $script:OcrEngine -and $script:OcrEngineTag -eq $tag) { return $script:OcrEngine }
        $null = [Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]
        $language = New-Object Windows.Globalization.Language $tag
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
    }
    if ($null -eq $engine) {
        $installed = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag })
        if ($installed.Count -eq 0) { throw 'no OCR language pack is installed on this machine' }
        throw ("no OCR engine for language '" + $tag + "'; installed: " + ($installed -join ', '))
    }
    $script:OcrEngine = $engine
    $script:OcrEngineTag = $tag
    return $engine
}

# Chinese and Japanese OCR emits one word per glyph, and Line.Text joins those
# words with spaces. Left alone, 「打开文件」 comes back as 「打 开 文 件」, which
# is four times the tokens and unreadable.
function Join-OcrLineText([string]$text) {
    $cjk = '[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]'
    return [regex]::Replace($text, "(?<=$cjk) (?=$cjk)", '')
}

# 小字号工具栏在 1:1 下认不出来（11px 中文就是边界），所以先按整数倍放大再识别。
# 放大用 HighQualityBicubic：邻近插值会把笔画糊成块，反而更认不出。放大后的坐标
# 由调用方除回原比例，对外仍然是物理屏幕像素。引擎对单边像素有上限，超了就抛，
# 让上层干净地退回原尺寸，而不是交给引擎抛一个难懂的错误。
function New-OcrScaledBitmap($bitmap, [int]$scale) {
    $maxDimension = 10000
    try { $maxDimension = [int][Windows.Media.Ocr.OcrEngine]::MaxImageDimension } catch { $maxDimension = 10000 }
    if ($maxDimension -le 0) { $maxDimension = 10000 }
    $width = [int]$bitmap.Width
    $height = [int]$bitmap.Height
    if ($width -lt 1 -or $height -lt 1) { throw '这张图没有可放大的像素' }
    if (($width * $scale) -gt $maxDimension -or ($height * $scale) -gt $maxDimension) {
        throw ("放大到 x$scale 会超过 OCR 引擎的单边上限 $maxDimension")
    }
    $scaled = New-Object System.Drawing.Bitmap ($width * $scale), ($height * $scale)
    $graphics = $null
    try {
        $graphics = [System.Drawing.Graphics]::FromImage($scaled)
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $graphics.DrawImage($bitmap, 0, 0, ($width * $scale), ($height * $scale))
    } catch {
        if ($null -ne $graphics) { $graphics.Dispose(); $graphics = $null }
        $scaled.Dispose()
        throw
    } finally {
        if ($null -ne $graphics) { $graphics.Dispose() }
    }
    return $scaled
}

function Invoke-OcrFile([string]$imagePath, $engine) {
    $null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
    $file = Wait-WinRt ([Windows.Storage.StorageFile]::GetFileFromPathAsync($imagePath)) ([Windows.Storage.StorageFile])
    $stream = Wait-WinRt ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    try {
        $decoder = Wait-WinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
        $bitmap = Wait-WinRt ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
        $result = Wait-WinRt ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
        $lines = New-Object System.Collections.ArrayList
        foreach ($line in $result.Lines) {
            $left = [double]::MaxValue
            $top = [double]::MaxValue
            $right = 0.0
            $bottom = 0.0
            foreach ($word in $line.Words) {
                $box = $word.BoundingRect
                if ($box.X -lt $left) { $left = $box.X }
                if ($box.Y -lt $top) { $top = $box.Y }
                if (($box.X + $box.Width) -gt $right) { $right = $box.X + $box.Width }
                if (($box.Y + $box.Height) -gt $bottom) { $bottom = $box.Y + $box.Height }
            }
            if ($right -le $left -or $bottom -le $top) { continue }
            $text = Join-OcrLineText ([string]$line.Text).Trim()
            if ($text.Length -eq 0) { continue }
            $null = $lines.Add([ordered]@{
                    text   = $text
                    x      = [int][Math]::Round($left)
                    y      = [int][Math]::Round($top)
                    width  = [int][Math]::Round($right - $left)
                    height = [int][Math]::Round($bottom - $top)
                })
        }
        return $lines
    } finally {
        $stream.Dispose()
    }
}

# computer_ocr: read the text of a rectangle and report where each line sits in
# physical screen pixels. The crop is saved at native resolution — the OCR
# engine is the one consumer that must never see a downscaled image.
# `scale` (1..3) 先放大再识别，用于小字号工具栏：识别完把坐标除回原比例，
# 对外仍然是物理屏幕像素。放大失败就退回 1，并在结果里如实说明。
function Invoke-OcrShot($argsIn) {
    if ([string]::IsNullOrWhiteSpace([string]$argsIn.outPath)) { throw "ocr needs a work image path" }
    $scale = 1
    if ($null -ne $argsIn.scale) { $scale = [int]$argsIn.scale }
    if ($scale -lt 1) { $scale = 1 }
    if ($scale -gt 3) { $scale = 3 }
    $source = Get-SourceBitmap $argsIn
    $cropped = $null
    $work = $null
    $applied = 1
    $scaleFailed = $false
    try {
        if ($null -ne $argsIn.x -and $null -ne $argsIn.y -and $null -ne $argsIn.width -and $null -ne $argsIn.height) {
            $cropped = Get-CroppedBitmap $source ([int]$argsIn.x) ([int]$argsIn.y) ([int]$argsIn.width) ([int]$argsIn.height)
        } else {
            $rect = New-Object System.Drawing.Rectangle 0, 0, ([int]$source.width), ([int]$source.height)
            $cropped = [ordered]@{
                bitmap = $source.bitmap.Clone($rect, $source.bitmap.PixelFormat)
                x      = $source.x
                y      = $source.y
                width  = $source.width
                height = $source.height
            }
        }
        $engine = Get-OcrEngine ([string]$argsIn.lang)
        $lines = $null
        $work = $cropped.bitmap
        if ($scale -gt 1) {
            try {
                $work = New-OcrScaledBitmap $cropped.bitmap $scale
                Save-BitmapPng $work ([string]$argsIn.outPath)
                $lines = Invoke-OcrFile ([string]$argsIn.outPath) $engine
                $applied = $scale
            } catch {
                # 放大或放大后的识别失败都不算错误：退回原尺寸再认一次，
                # 并在结果里如实说明，调用方不该因为「想放大」而失去这次识别。
                $lines = $null
                $applied = 1
                $scaleFailed = $true
            }
        }
        if ($null -eq $lines) {
            if ($null -ne $work -and -not [object]::ReferenceEquals($work, $cropped.bitmap)) {
                $work.Dispose()
            }
            $work = $cropped.bitmap
            Save-BitmapPng $work ([string]$argsIn.outPath)
            $lines = Invoke-OcrFile ([string]$argsIn.outPath) $engine
        }
        # 放大后的坐标先除回原比例（左右、上下分别取整，避免宽高各差 1 px），
        # 再整体平移到屏幕原点：调用方拿到的永远是物理屏幕像素。
        if ($applied -gt 1) {
            foreach ($line in $lines) {
                $left = [int][Math]::Round($line.x / $applied)
                $top = [int][Math]::Round($line.y / $applied)
                $right = [int][Math]::Round(($line.x + $line.width) / $applied)
                $bottom = [int][Math]::Round(($line.y + $line.height) / $applied)
                $line.x = $left
                $line.y = $top
                $line.width = [int][Math]::Max(1, ($right - $left))
                $line.height = [int][Math]::Max(1, ($bottom - $top))
            }
        }
        # Rebase the boxes onto the screen so callers never have to add an
        # origin: these coordinates go straight into computer_click space:screen.
        foreach ($line in $lines) {
            $line.x = [int]$line.x + [int]$cropped.x
            $line.y = [int]$line.y + [int]$cropped.y
        }
        return [ordered]@{
            kind       = $source.kind
            handle     = $(if ($null -ne $source.handle) { $source.handle } else { 0 })
            title      = $(if ($null -ne $source.title) { $source.title } else { '' })
            monitor    = $(if ($null -ne $source.monitor) { $source.monitor } else { 0 })
            x          = $cropped.x
            y          = $cropped.y
            width      = $cropped.width
            height     = $cropped.height
            language   = [string]$engine.RecognizerLanguage.LanguageTag
            printed    = $(if ($null -ne $source.printed) { [bool]$source.printed } else { $false })
            scale      = $applied
            scaleAsked = $scale
            scaleFailed = [bool]$scaleFailed
            lines      = $lines
            lineCount  = $lines.Count
            capturedAt = [DateTime]::UtcNow.ToString('o')
        }
    } finally {
        if ($null -ne $work -and $null -ne $cropped -and -not [object]::ReferenceEquals($work, $cropped.bitmap)) {
            $work.Dispose()
        }
        if ($null -ne $cropped -and $null -ne $cropped.bitmap) { $cropped.bitmap.Dispose() }
        $source.bitmap.Dispose()
    }
}

function Invoke-Screenshot($argsIn) {
    $monitor = 1
    if ($null -ne $argsIn.monitor) { $monitor = [int]$argsIn.monitor }
    $maxWidth = 1600
    if ($null -ne $argsIn.maxWidth) { $maxWidth = [int]$argsIn.maxWidth }
    if ([string]::IsNullOrWhiteSpace([string]$argsIn.outPath)) { throw "screenshot needs an output path" }

    $screens = [System.Windows.Forms.Screen]::AllScreens
    if ($monitor -lt 1 -or $monitor -gt $screens.Count) { throw "monitor $monitor is outside 1..$($screens.Count)" }
    $screen = $screens[$monitor - 1]
    $bounds = $screen.Bounds

    $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bitmap.Size)
    } finally {
        $graphics.Dispose()
    }

    # Our own floating windows (the docked panel, the capture preview) sit on top and
    # repaint constantly, which made two captures of a still screen differ byte for
    # byte. They hide whatever is behind them anyway, so painting them flat costs no
    # information the model could otherwise have had. `masks` is a list; `mask` is
    # accepted as the single-rectangle form.
    $maskList = @()
    if ($null -ne $argsIn.masks) { $maskList = @($argsIn.masks) }
    elseif ($null -ne $argsIn.mask) { $maskList = @($argsIn.mask) }
    if ($maskList.Count -gt 0) {
        $fill = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 24, 26, 30))
        $maskGraphics = [System.Drawing.Graphics]::FromImage($bitmap)
        try {
            foreach ($mask in $maskList) {
                if ($null -eq $mask) { continue }
                $maskWidth = [int]$mask.width
                $maskHeight = [int]$mask.height
                if ($maskWidth -le 0 -or $maskHeight -le 0) { continue }
                $maskX = [int]$mask.x - $bounds.X
                $maskY = [int]$mask.y - $bounds.Y
                $maskGraphics.FillRectangle($fill, $maskX, $maskY, $maskWidth, $maskHeight)
            }
        } finally {
            $maskGraphics.Dispose()
            $fill.Dispose()
        }
    }

    $scale = 1.0
    if ($maxWidth -gt 0 -and $bounds.Width -gt $maxWidth) { $scale = $maxWidth / $bounds.Width }
    $imageWidth = [int][Math]::Round($bounds.Width * $scale)
    $imageHeight = [int][Math]::Round($bounds.Height * $scale)

    if ($imageWidth -ne $bounds.Width -or $imageHeight -ne $bounds.Height) {
        $resized = New-Object System.Drawing.Bitmap $imageWidth, $imageHeight
        $resizeGraphics = [System.Drawing.Graphics]::FromImage($resized)
        try {
            $resizeGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $resizeGraphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $resizeGraphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
            $resizeGraphics.DrawImage($bitmap, 0, 0, $imageWidth, $imageHeight)
        } finally {
            $resizeGraphics.Dispose()
            $bitmap.Dispose()
        }
        $bitmap = $resized
    }

    $directory = [System.IO.Path]::GetDirectoryName([string]$argsIn.outPath)
    if ($directory -and -not (Test-Path -LiteralPath $directory)) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
    $bitmap.Save([string]$argsIn.outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bitmap.Dispose()

    $cursorX = [DshWin]::CursorX()
    $cursorY = [DshWin]::CursorY()
    $foreground = [DshWin]::Foreground()

    return [ordered]@{
        path = [string]$argsIn.outPath
        monitor = $monitor
        screenX = $bounds.X
        screenY = $bounds.Y
        screenWidth = $bounds.Width
        screenHeight = $bounds.Height
        imageWidth = $imageWidth
        imageHeight = $imageHeight
        monitors = Get-Monitors
        cursor = [ordered]@{ x = $cursorX; y = $cursorY }
        activeWindow = [ordered]@{
            handle = $foreground
            title = [DshWin]::WindowTitle($foreground)
            process = (Get-ProcessNameForWindow $foreground)
        }
        capturedAt = [DateTime]::UtcNow.ToString('o')
    }
}

function Invoke-Click($argsIn) {
    $started = [DateTime]::UtcNow
    $x = [int]$argsIn.x
    $y = [int]$argsIn.y
    $button = 'left'
    if ($argsIn.button) { $button = ([string]$argsIn.button).ToLowerInvariant() }
    $clicks = 1
    if ($null -ne $argsIn.clicks) { $clicks = [int]$argsIn.clicks }
    if ($clicks -lt 1) { $clicks = 1 }
    if ($clicks -gt 3) { $clicks = 3 }
    $holdMs = 0
    if ($null -ne $argsIn.holdMs) { $holdMs = [int]$argsIn.holdMs }
    if ($holdMs -lt 0) { $holdMs = 0 }

    [DshWin]::MoveAbs($x, $y) | Out-Null
    Start-Sleep -Milliseconds 25
    if ($button -eq 'move') {
        return [ordered]@{
            acted = 'move'; x = $x; y = $y
            cursorX = [DshWin]::CursorX(); cursorY = [DshWin]::CursorY()
            tookMs = [int]([DateTime]::UtcNow - $started).TotalMilliseconds
        }
    }

    $down = 0x0002
    $up = 0x0004
    if ($button -eq 'right') { $down = 0x0008; $up = 0x0010 }
    elseif ($button -eq 'middle') { $down = 0x0020; $up = 0x0040 }

    for ($i = 0; $i -lt $clicks; $i++) {
        [DshWin]::Button($down)
        if ($holdMs -gt 0) { Start-Sleep -Milliseconds $holdMs } else { Start-Sleep -Milliseconds 20 }
        [DshWin]::Button($up)
        if ($i -lt ($clicks - 1)) { Start-Sleep -Milliseconds 70 }
    }
    # 光标实测位置：请求值不等于落点（被别的窗口拒绝、系统吸边、显示器边界）时，
    # 只有这个数字能说明真相。
    return [ordered]@{
        acted = 'click'; x = $x; y = $y; button = $button; clicks = $clicks
        cursorX = [DshWin]::CursorX(); cursorY = [DshWin]::CursorY()
        tookMs = [int]([DateTime]::UtcNow - $started).TotalMilliseconds
    }
}

function Invoke-Drag($argsIn) {
    $fromX = [int]$argsIn.fromX
    $fromY = [int]$argsIn.fromY
    $toX = [int]$argsIn.toX
    $toY = [int]$argsIn.toY
    $button = 'left'
    if ($argsIn.button) { $button = ([string]$argsIn.button).ToLowerInvariant() }
    $down = 0x0002
    $up = 0x0004
    if ($button -eq 'right') { $down = 0x0008; $up = 0x0010 }
    elseif ($button -eq 'middle') { $down = 0x0020; $up = 0x0040 }

    [DshWin]::MoveAbs($fromX, $fromY) | Out-Null
    Start-Sleep -Milliseconds 60
    [DshWin]::Button($down)
    Start-Sleep -Milliseconds 80
    $steps = 18
    for ($s = 1; $s -le $steps; $s++) {
        $ratio = $s / $steps
        $cx = [int][Math]::Round($fromX + ($toX - $fromX) * $ratio)
        $cy = [int][Math]::Round($fromY + ($toY - $fromY) * $ratio)
        [DshWin]::MoveAbs($cx, $cy) | Out-Null
        Start-Sleep -Milliseconds 12
    }
    Start-Sleep -Milliseconds 80
    [DshWin]::Button($up)
    return [ordered]@{ acted = 'drag'; fromX = $fromX; fromY = $fromY; toX = $toX; toY = $toY; button = $button }
}

function Invoke-Scroll($argsIn) {
    $direction = 'down'
    if ($argsIn.direction) { $direction = ([string]$argsIn.direction).ToLowerInvariant() }
    $amount = 3
    if ($null -ne $argsIn.amount) { $amount = [int]$argsIn.amount }
    if ($amount -lt 1) { $amount = 1 }
    if ($amount -gt 30) { $amount = 30 }
    if ($null -ne $argsIn.x -and $null -ne $argsIn.y) {
        [DshWin]::MoveAbs([int]$argsIn.x, [int]$argsIn.y) | Out-Null
        Start-Sleep -Milliseconds 40
    }
    $unit = 120 * $amount
    switch ($direction) {
        'up' { [DshWin]::Wheel($unit) }
        'down' { [DshWin]::Wheel(-$unit) }
        'left' { [DshWin]::HScroll($unit) }
        'right' { [DshWin]::HScroll(-$unit) }
        default { throw "scroll direction must be up, down, left, or right" }
    }
    Start-Sleep -Milliseconds 90
    return [ordered]@{ acted = 'scroll'; direction = $direction; amount = $amount }
}

function Invoke-Type($argsIn) {
    $text = [string]$argsIn.text
    if ([string]::IsNullOrEmpty($text)) { throw "text must be a non-empty string" }
    $previous = Get-ClipboardTextSafe
    Set-ClipboardText $text
    Start-Sleep -Milliseconds 200
    [DshWin]::Key([uint16]17, $false, $false)
    Start-Sleep -Milliseconds 12
    [DshWin]::Key([uint16]86, $false, $false)
    Start-Sleep -Milliseconds 30
    [DshWin]::Key([uint16]86, $true, $false)
    Start-Sleep -Milliseconds 12
    [DshWin]::Key([uint16]17, $true, $false)
    Start-Sleep -Milliseconds 160
    if ($argsIn.submit -eq $true) {
        Start-Sleep -Milliseconds 120
        [DshWin]::Key([uint16]13, $false, $false)
        Start-Sleep -Milliseconds 20
        [DshWin]::Key([uint16]13, $true, $false)
        Start-Sleep -Milliseconds 120
    }
    # Restore late and only if nobody replaced our text: a target that processes
    # Ctrl+V slowly would otherwise paste the restored (stale) clipboard.
    if ($null -ne $previous -and $previous -ne $text) {
        Start-Sleep -Milliseconds 1200
        try {
            if ((Get-ClipboardTextSafe) -eq $text) { Set-ClipboardText $previous }
        } catch { }
    }
    return [ordered]@{ acted = 'type'; characters = $text.Length; submitted = ($argsIn.submit -eq $true) }
}

function Invoke-WindowRect($argsIn) {
    $handle = [long]$argsIn.handle
    $box = [DshWin]::VisibleRectOf($handle)
    if ($null -eq $box) { throw "window $handle no longer exists" }
    $foreground = [DshWin]::Foreground()
    return [ordered]@{
        handle      = $handle
        x           = [int]$box[0]
        y           = [int]$box[1]
        width       = [int]$box[2]
        height      = [int]$box[3]
        title       = [DshWin]::WindowTitle($handle)
        active      = ($foreground -eq $handle)
        minimized   = [bool][DshWin]::IsIconic([IntPtr]$handle)
    }
}

function Invoke-WindowShot($argsIn) {
    $handle = [long]$argsIn.handle
    $maxWidth = 1600
    if ($null -ne $argsIn.maxWidth) { $maxWidth = [int]$argsIn.maxWidth }
    if ([string]::IsNullOrWhiteSpace([string]$argsIn.outPath)) { throw "window capture needs an output path" }

    $box = [DshWin]::VisibleRectOf($handle)
    if ($null -eq $box) { throw "window $handle no longer exists" }
    $windowX = [int]$box[0]
    $windowY = [int]$box[1]
    $width = [int]$box[2]
    $height = [int]$box[3]
    if ($width -lt 8 -or $height -lt 8) { throw "window $handle is minimized or has no drawable area" }

    $bitmap = New-Object System.Drawing.Bitmap $width, $height
    $printOk = $false
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $hdc = $graphics.GetHdc()
    try {
        $printOk = [DshWin]::PrintWindow([IntPtr]$handle, $hdc, 2)
    } finally {
        $graphics.ReleaseHdc($hdc)
        $graphics.Dispose()
    }
    if (-not $printOk) {
        # Some windows refuse PrintWindow; a screen copy of the same rectangle works
        # whenever the window is actually visible.
        $copy = [System.Drawing.Graphics]::FromImage($bitmap)
        try {
            $copy.CopyFromScreen($windowX, $windowY, 0, 0, $bitmap.Size)
        } finally {
            $copy.Dispose()
        }
    }

    $scale = 1.0
    if ($maxWidth -gt 0 -and $width -gt $maxWidth) { $scale = $maxWidth / $width }
    $imageWidth = [int][Math]::Round($width * $scale)
    $imageHeight = [int][Math]::Round($height * $scale)
    if ($imageWidth -ne $width -or $imageHeight -ne $height) {
        $resized = New-Object System.Drawing.Bitmap $imageWidth, $imageHeight
        $resizeGraphics = [System.Drawing.Graphics]::FromImage($resized)
        try {
            $resizeGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $resizeGraphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $resizeGraphics.DrawImage($bitmap, 0, 0, $imageWidth, $imageHeight)
        } finally {
            $resizeGraphics.Dispose()
            $bitmap.Dispose()
        }
        $bitmap = $resized
    }

    $directory = [System.IO.Path]::GetDirectoryName([string]$argsIn.outPath)
    if ($directory -and -not (Test-Path -LiteralPath $directory)) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
    $bitmap.Save([string]$argsIn.outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bitmap.Dispose()

    return [ordered]@{
        path        = [string]$argsIn.outPath
        handle      = $handle
        x           = $windowX
        y           = $windowY
        width       = $width
        height      = $height
        imageWidth  = $imageWidth
        imageHeight = $imageHeight
        title       = [DshWin]::WindowTitle($handle)
        process     = (Get-ProcessNameForWindow $handle)
        printed     = [bool]$printOk
        capturedAt  = [DateTime]::UtcNow.ToString('o')
    }
}
function Invoke-Focus($argsIn) {
    $handle = [long]$argsIn.handle
    $before = [DshWin]::Foreground()
    $ok = [DshWin]::Focus($handle)
    Start-Sleep -Milliseconds 120
    $foreground = [DshWin]::Foreground()
    return [ordered]@{
        requested = $handle
        foreground = $foreground
        focused = ($foreground -eq $handle)
        accepted = [bool]$ok
        wasForeground = ($before -eq $handle)
        title = [DshWin]::WindowTitle($foreground)
    }
}

# ── UI Automation: name controls instead of guessing pixels ────────────────
function Get-UiElementPatterns($element) {
    $names = @()
    $target = $null
    if ($element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$target)) { $names += 'invoke' }
    if ($element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$target)) { $names += 'select' }
    if ($element.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$target)) { $names += 'toggle' }
    if ($element.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$target)) { $names += 'expand' }
    if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$target)) { $names += 'value' }
    return $names
}

# A virtualized or half-realized element reports an empty rectangle whose members
# are infinities. Casting one to Int32 aborts the entire walk, which used to look
# like "this window has no control tree" for apps that do expose one.
function ConvertTo-UiInt([double]$value) {
    if ([double]::IsNaN($value) -or [double]::IsInfinity($value)) { return 0 }
    if ($value -gt 2147483647) { return 2147483647 }
    if ($value -lt -2147483648) { return -2147483648 }
    return [int][math]::Round($value)
}

function Get-UiTree([long]$handle, [int]$depth, [int]$limit) {
    Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
    Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop
    $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$handle)
    if ($null -eq $root) { throw "窗口 $handle 没有可访问的元素树" }
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $results = New-Object System.Collections.ArrayList

    $walk = $null
    $walk = {
        param($element, [string]$path, [int]$level)
        if ($results.Count -ge $limit) { return }
        try {
            $current = $element.Current
        } catch {
            return
        }
        $rect = $null
        try { $rect = $current.BoundingRectangle } catch { $rect = $null }
        $rx = 0; $ry = 0; $rw = 0; $rh = 0
        if ($null -ne $rect) {
            $rx = ConvertTo-UiInt $rect.X
            $ry = ConvertTo-UiInt $rect.Y
            $rw = ConvertTo-UiInt $rect.Width
            $rh = ConvertTo-UiInt $rect.Height
        }
        $kind = ([string]$current.ControlType.ProgrammaticName) -replace '^ControlType\.', ''
        $patterns = @()
        try { $patterns = @(Get-UiElementPatterns $element) } catch { $patterns = @() }
        $null = $results.Add([ordered]@{
                index = $results.Count
                path = $path
                name = [string]$current.Name
                type = $kind
                id = [string]$current.AutomationId
                x = $rx
                y = $ry
                width = $rw
                height = $rh
                enabled = [bool]$current.IsEnabled
                offscreen = [bool]$current.IsOffscreen
                patterns = $patterns
            })
        if ($level -ge $depth) { return }
        try {
            $child = $walker.GetFirstChild($element)
        } catch {
            return
        }
        $position = 0
        while ($null -ne $child -and $results.Count -lt $limit) {
            & $walk $child ("$path/$position") ($level + 1)
            try {
                $child = $walker.GetNextSibling($child)
            } catch {
                break
            }
            $position = $position + 1
        }
    }

    & $walk $root '0' 0
    $visible = @($results | Where-Object { $_.offscreen -eq $false -and $_.width -gt 0 -and $_.height -gt 0 })
    return [ordered]@{ handle = $handle; count = $results.Count; visible = $visible.Count; elements = $results }
}

# ── 命中探测：某个屏幕点上真正压着的是什么 ─────────────────────────────────
# 点击工具过去只说「打到了哪个像素」，模型没法判断自己点中的是拖拽热区、浮层
# 还是别的窗口，于是一遍遍试。UI Automation 的 ElementFromPoint 能直接回答这个
# 问题；它必须在动作**之后**调用（点开菜单/弹出浮层之后元素才存在），并且这里
# 的任何异常都只代表「取不到」，不许连累已经完成的动作。
$script:uiaLoaded = $false

function Initialize-Uia {
    if ($script:uiaLoaded) { return }
    Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
    Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop
    # System.Windows.Point 在 WindowsBase 里；缺了它就做不出 FromPoint 的参数。
    Add-Type -AssemblyName WindowsBase -ErrorAction Stop
    $script:uiaLoaded = $true
}

function Get-HitAt([int]$x, [int]$y) {
    Initialize-Uia
    $point = New-Object System.Windows.Point ([double]$x), ([double]$y)
    # 辅助进程是 STA 启动的（host.js 传了 -Sta），UIA 客户端要求这个线程模型。
    $element = [System.Windows.Automation.AutomationElement]::FromPoint($point)
    if ($null -eq $element) { throw "屏幕点 ($x, $y) 上取不到 UI 自动化元素" }
    $current = $element.Current
    $kind = ([string]$current.ControlType.ProgrammaticName) -replace '^ControlType\.', ''
    # 元素矩形与所在窗口：调用方靠它把「点在哪」变成「点到了哪个控件的哪个位置」，
    # 吸附、落点核对、自家浮层遮挡判断都建立在这两个字段上。
    $rx = 0; $ry = 0; $rw = 0; $rh = 0
    try {
        $box = $current.BoundingRectangle
        if ($null -ne $box -and -not [double]::IsNaN($box.Width) -and $box.Width -gt 0 -and $box.Height -gt 0) {
            $rx = [int][Math]::Round($box.X)
            $ry = [int][Math]::Round($box.Y)
            $rw = [int][Math]::Round($box.Width)
            $rh = [int][Math]::Round($box.Height)
        }
    } catch { }
    $root = 0
    $windowTitle = ''
    try {
        $root = [DshWin]::RootAt($x, $y)
        if ($root -ne 0) { $windowTitle = [DshWin]::WindowTitle($root) }
    } catch { }
    return [ordered]@{
        x           = $x
        y           = $y
        controlType = $kind
        name        = [string]$current.Name
        class       = [string]$current.ClassName
        processId   = [int]$current.ProcessId
        rect        = [ordered]@{ x = $rx; y = $ry; width = $rw; height = $rh }
        hwnd        = $root
        window      = $windowTitle
    }
}

# 单点：{x, y} -> {controlType, name, class, processId}
# 多点：{points: [{x, y}, ...]} -> {hits: [...]}，一个请求问完所有候选行，
# 省掉 anchor 解析时每个候选一次的往返；单点失败只让那一项 ok=false。
function Invoke-Hit($argsIn) {
    if ($null -ne $argsIn.points) {
        $hits = New-Object System.Collections.ArrayList
        foreach ($point in @($argsIn.points)) {
            if ($hits.Count -ge 32) { break }
            if ($null -eq $point) { continue }
            $px = [int]$point.x
            $py = [int]$point.y
            try {
                $hit = Get-HitAt $px $py
                $hit.ok = $true
                $null = $hits.Add($hit)
            } catch {
                $null = $hits.Add([ordered]@{
                        x     = $px
                        y     = $py
                        ok    = $false
                        error = [string]$_.Exception.Message
                    })
            }
        }
        return [ordered]@{ count = $hits.Count; hits = $hits }
    }
    $single = Get-HitAt ([int]$argsIn.x) ([int]$argsIn.y)
    $single.ok = $true
    return $single
}

# 一小块画面的指纹：默认 8×6 个采样点的 RGB。只回答「这一下有没有让画面变」，
# 不是哈希也不需要精确——同一块像素重复取必须完全一致，这点由采样点固定保证。
function Invoke-Signature($argsIn) {
    $x = [int]$argsIn.x
    $y = [int]$argsIn.y
    $width = [int]$argsIn.width
    $height = [int]$argsIn.height
    if ($width -lt 4 -or $height -lt 4) { throw 'signature region is too small' }
    $cols = 8
    $rows = 6
    if ($null -ne $argsIn.cols) { $cols = [Math]::Min([Math]::Max([int]$argsIn.cols, 2), 64) }
    if ($null -ne $argsIn.rows) { $rows = [Math]::Min([Math]::Max([int]$argsIn.rows, 2), 64) }
    $values = Get-FrameSignature $x $y $width $height $cols $rows
    return [ordered]@{
        x = $x; y = $y; width = $width; height = $height
        cols = $cols; rows = $rows
        samples = @($values)
    }
}

# 插件自己的浮层（卡片、提示、状态条、预览）也是真实窗口，会吃掉点击。
# 点刚好落在它们上面时，临时让它穿透，点完立刻恢复——否则用户看到的是
# 「点了没反应」，而实际上点到了自己的卡片。
function Get-OwnWindowAt([int]$x, [int]$y) {
    try {
        $handle = [DshWin]::RootAt($x, $y)
        if ($handle -eq 0) { return 0 }
        $title = [DshWin]::WindowTitle($handle)
        if ($title -like 'DSH computer use*') { return $handle }
    } catch { }
    return 0
}

function Invoke-UiAct($argsIn) {
    Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
    Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop
    $handle = [long]$argsIn.handle
    $path = [string]$argsIn.path
    $action = [string]$argsIn.action
    $tree = Get-UiTree $handle 12 400
    $target = $null
    foreach ($element in $tree.elements) {
        if ([string]$element.path -eq $path) { $target = $element; break }
    }
    if ($null -eq $target) { throw "这个元素不在当前窗口里（可能界面已经变了），请重新列出元素树" }

    $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$handle)
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $node = $null
    $walk = $null
    $walk = {
        param($element, [string]$currentPath, [int]$level)
        if ($null -ne $node) { return }
        if ($level -gt 12) { return }
        if ($currentPath -eq $path) { $script:uiFound = $element; return }
        try { $child = $walker.GetFirstChild($element) } catch { return }
        $position = 0
        while ($null -ne $child) {
            & $walk $child ("$currentPath/$position") ($level + 1)
            if ($null -ne $script:uiFound) { return }
            try { $child = $walker.GetNextSibling($child) } catch { break }
            $position = $position + 1
        }
    }
    $script:uiFound = $null
    & $walk $root '0' 0
    $node = $script:uiFound
    $script:uiFound = $null
    if ($null -eq $node) { throw "这个元素不在当前窗口里（可能界面已经变了），请重新列出元素树" }

    # A path is a position in the tree, not an identity: when the UI shifts, the
    # same path can land on a different control, and activating it silently does
    # the wrong thing. The caller sends what it actually saw at that path, so a
    # mismatch is refused instead of guessed at. This runs on the node we are
    # about to act on, before any action, so there is no window to race.
    $expectType = [string]$argsIn.expectType
    $expectName = [string]$argsIn.expectName
    if ($expectType.Length -gt 0 -or $expectName.Length -gt 0) {
        $nowType = ([string]$node.Current.ControlType.ProgrammaticName) -replace '^ControlType\.', ''
        $nowName = [string]$node.Current.Name
        if ($expectType.Length -gt 0 -and $nowType -ne $expectType) {
            throw ("STALE_REF: 路径 $path 现在是 $nowType「$nowName」，你读到的是 $expectType「$expectName」。界面已经变了，动作已取消——请重新读取元素树再操作。")
        }
        if ($expectName.Length -gt 0 -and $nowName -ne $expectName) {
            throw ("STALE_REF: 路径 $path 现在叫「$nowName」，你读到的是「$expectName」。界面已经变了，动作已取消——请重新读取元素树再操作。")
        }
    }

    $pattern = $null
    $acted = 'none'
    switch ($action) {
        'invoke' {
            if ($node.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
                $pattern.Invoke()
                $acted = 'invoke'
            }
        }
        'select' {
            if ($node.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {
                $pattern.Select()
                $acted = 'select'
            }
        }
        'toggle' {
            if ($node.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pattern)) {
                $pattern.Toggle()
                $acted = 'toggle'
            }
        }
        'expand' {
            if ($node.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pattern)) {
                $pattern.Expand()
                $acted = 'expand'
            }
        }
        'value' {
            if ($node.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
                $pattern.SetValue([string]$argsIn.value)
                $acted = 'value'
            }
        }
        'type' {
            # Writing through the Value pattern reaches a window that is neither
            # focused nor in front: no cursor movement, no clipboard, no stolen
            # keystrokes. That is the whole point of this action — computer_type
            # falls back to pasting only when an element refuses it.
            $valuePattern = $null
            if (-not $node.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) {
                throw '这个元素没有 Value 模式，无法在后台写入'
            }
            if ($valuePattern.Current.IsReadOnly) { throw '这个元素是只读的，无法写入' }
            $previous = [string]$valuePattern.Current.Value
            $addition = [string]$argsIn.value
            if ([string]$argsIn.mode -eq 'replace') { $next = $addition } else { $next = $previous + $addition }
            # Some providers realize (and therefore focus) the control to apply the
            # change. That is the one side effect this path can have, so it is
            # measured rather than assumed.
            $previousForeground = [DshWin]::Foreground()
            $valuePattern.SetValue($next)
            Start-Sleep -Milliseconds 80
            $script:uiTypedForeground = [DshWin]::Foreground()
            $script:uiTypedPreviousForeground = $previousForeground
            $acted = 'type'
            $script:uiTypedBefore = $previous.Length
            $script:uiTypedAfter = $next.Length
        }
        'focus' {
            $node.SetFocus()
            $acted = 'focus'
        }
        'click' {
            $rect = $node.Current.BoundingRectangle
            $x = ConvertTo-UiInt ($rect.X + $rect.Width / 2)
            $y = ConvertTo-UiInt ($rect.Y + $rect.Height / 2)
            if ($x -eq 0 -and $y -eq 0) { throw '这个元素没有可用的屏幕坐标（可能是虚拟化或屏外的元素）' }
            [DshWin]::MoveAbs($x, $y) | Out-Null
            [DshWin]::Button(0x0002)
            [DshWin]::Button(0x0004)
            $acted = 'click'
        }
    }
    if ($acted -eq 'none') { throw "这个元素不支持所要执行的动作（可用：$([string]::Join(', ', $target.patterns))）" }
    Start-Sleep -Milliseconds 150
    $result = [ordered]@{ acted = $acted; handle = $handle; path = $path; name = $target.name; type = $target.type }
    if ($acted -eq 'type') {
        # Report the size change so the caller can say exactly what landed,
        # since nothing about this path touches the screen or the clipboard.
        $result.beforeLength = $script:uiTypedBefore
        $result.afterLength = $script:uiTypedAfter
        $result.foreground = $script:uiTypedForeground
        $result.previousForeground = $script:uiTypedPreviousForeground
        $script:uiTypedBefore = 0
        $script:uiTypedAfter = 0
        $script:uiTypedForeground = 0
        $script:uiTypedPreviousForeground = 0
    }
    return $result
}
# ── waiting: stop burning screenshots just to pass time ────────────────────
function Get-FrameSignature([int]$x, [int]$y, [int]$width, [int]$height, [int]$cols = 40, [int]$rows = 24) {
    if ($width -lt 4 -or $height -lt 4) { throw 'region is too small to sample' }
    $bitmap = New-Object System.Drawing.Bitmap $width, $height
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size($width, $height)), [System.Drawing.CopyPixelOperation]::SourceCopy)
    } finally {
        $graphics.Dispose()
    }
    $values = New-Object 'System.Int32[]' ($cols * $rows * 3)
    $index = 0
    try {
        for ($row = 0; $row -lt $rows; $row++) {
            $py = [int](($row + 0.5) * $height / $rows)
            if ($py -ge $height) { $py = $height - 1 }
            for ($col = 0; $col -lt $cols; $col++) {
                $px = [int](($col + 0.5) * $width / $cols)
                if ($px -ge $width) { $px = $width - 1 }
                $color = $bitmap.GetPixel($px, $py)
                $values[$index] = [int]$color.R
                $values[$index + 1] = [int]$color.G
                $values[$index + 2] = [int]$color.B
                $index = $index + 3
            }
        }
    } finally {
        $bitmap.Dispose()
    }
    return $values
}

function Compare-Signature($left, $right, [int]$tolerance) {
    if ($null -eq $left -or $null -eq $right) { return 1.0 }
    if ($left.Length -ne $right.Length) { return 1.0 }
    $changed = 0
    $samples = [int]($left.Length / 3)
    for ($index = 0; $index -lt $left.Length; $index += 3) {
        $delta = [Math]::Abs($left[$index] - $right[$index])
        $green = [Math]::Abs($left[$index + 1] - $right[$index + 1])
        $blue = [Math]::Abs($left[$index + 2] - $right[$index + 2])
        if ($delta -gt $green) { $green = $delta }
        if ($green -lt $blue) { $green = $blue }
        if ($green -gt $tolerance) { $changed = $changed + 1 }
    }
    return [double]$changed / [Math]::Max(1, $samples)
}

function Resolve-WaitRegion($argsIn) {
    if ($null -ne $argsIn.handle -and [long]$argsIn.handle -gt 0) {
        $box = [DshWin]::VisibleRectOf([long]$argsIn.handle)
        if ($null -eq $box) { throw "window $($argsIn.handle) no longer exists" }
        return @{ x = [int]$box[0]; y = [int]$box[1]; width = [int]$box[2]; height = [int]$box[3] }
    }
    if ($null -ne $argsIn.x -and $null -ne $argsIn.y -and $null -ne $argsIn.width -and $null -ne $argsIn.height) {
        return @{ x = [int]$argsIn.x; y = [int]$argsIn.y; width = [int]$argsIn.width; height = [int]$argsIn.height }
    }
    $box = [DshWin]::VisibleRectOf([DshWin]::Foreground())
    return @{ x = [int]$box[0]; y = [int]$box[1]; width = [int]$box[2]; height = [int]$box[3] }
}

function Invoke-Wait($argsIn) {
    $region = Resolve-WaitRegion $argsIn
    $mode = [string]$argsIn.mode
    if ([string]::IsNullOrWhiteSpace($mode)) { $mode = 'stable' }
    $timeoutMs = 15000
    if ($null -ne $argsIn.timeoutMs) { $timeoutMs = [Math]::Min([Math]::Max([int]$argsIn.timeoutMs, 500), 120000) }
    $intervalMs = 350
    if ($null -ne $argsIn.intervalMs) { $intervalMs = [Math]::Min([Math]::Max([int]$argsIn.intervalMs, 100), 2000) }
    $tolerance = 12
    if ($null -ne $argsIn.tolerance) { $tolerance = [Math]::Min([Math]::Max([int]$argsIn.tolerance, 0), 80) }
    $threshold = 0.01
    if ($null -ne $argsIn.threshold) { $threshold = [Math]::Min([Math]::Max([double]$argsIn.threshold, 0.0001), 1.0) }

    $deadline = [DateTime]::UtcNow.AddMilliseconds($timeoutMs)
    $started = [DateTime]::UtcNow
    $previous = $null
    $stableHits = 0
    $lastDiff = 1.0
    while ($true) {
        $signature = Get-FrameSignature $region.x $region.y $region.width $region.height
        if ($null -ne $previous) {
            $lastDiff = Compare-Signature $previous $signature $tolerance
            if ($mode -eq 'change') {
                if ($lastDiff -ge $threshold) {
                    return [ordered]@{ stable = $false; changed = $true; diff = [Math]::Round($lastDiff, 4); elapsedMs = [int]([DateTime]::UtcNow - $started).TotalMilliseconds; region = $region }
                }
            } elseif ($mode -eq 'same') {
                if ($lastDiff -le $threshold) {
                    return [ordered]@{ stable = $true; changed = $false; diff = [Math]::Round($lastDiff, 4); elapsedMs = [int]([DateTime]::UtcNow - $started).TotalMilliseconds; region = $region }
                }
            } else {
                if ($lastDiff -le $threshold) { $stableHits = $stableHits + 1 } else { $stableHits = 0 }
                if ($stableHits -ge 2) {
                    return [ordered]@{ stable = $true; changed = $false; diff = [Math]::Round($lastDiff, 4); elapsedMs = [int]([DateTime]::UtcNow - $started).TotalMilliseconds; region = $region }
                }
            }
        }
        $previous = $signature
        if ([DateTime]::UtcNow -gt $deadline) {
            return [ordered]@{ stable = $false; changed = ($lastDiff -ge $threshold); timedOut = $true; diff = [Math]::Round($lastDiff, 4); elapsedMs = [int]([DateTime]::UtcNow - $started).TotalMilliseconds; region = $region }
        }
        Start-Sleep -Milliseconds $intervalMs
    }
}

function Invoke-Dock($argsIn) {
    $handle = 0L
    if ($null -ne $argsIn.handle) { $handle = [long]$argsIn.handle }
    if ($handle -eq 0 -and $null -ne $argsIn.pid) { $handle = [DshWin]::MainWindowOf([int]$argsIn.pid) }
    if ($handle -eq 0 -and -not [string]::IsNullOrWhiteSpace([string]$argsIn.process)) {
        $wanted = [string]$argsIn.process
        $bestArea = 0
        foreach ($candidate in [DshWin]::ListWindows()) {
            $name = Get-ProcessNameForWindow $candidate.handle
            # A minimised window reports a 160x28 rect at -32000, so the width test
            # used to skip it entirely and docking failed with "no window to dock".
            # Accept it, but always prefer a visible window when there is one.
            $isMinimized = [DshWin]::IsIconic([IntPtr]$candidate.handle)
            if ($name -like "*$wanted*" -and ($candidate.width -gt 240 -or $isMinimized)) {
                $area = 1
                if (-not $isMinimized) { $area = $candidate.width * $candidate.height }
                if ($area -gt $bestArea) { $bestArea = $area; $handle = $candidate.handle }
            }
        }
    }
    if ($handle -eq 0) { throw 'no window to dock (pass handle or pid)' }

    $wasMinimized = [DshWin]::IsIconic([IntPtr]$handle)

    if ($argsIn.restore -eq $true) {
        $saved = [string]$argsIn.saved
        $parts = $saved -split ','
        if ($parts.Count -ne 4) { throw "saved rect is not x,y,w,h: $saved" }
        [DshWin]::ShowWindow([IntPtr]$handle, 9) | Out-Null
        [DshWin]::SetWindowPos([IntPtr]$handle, [IntPtr]::Zero, [int]$parts[0], [int]$parts[1], [int]$parts[2], [int]$parts[3], 0x0010 -bor 0x0040) | Out-Null
        try { Remove-Item -LiteralPath (Join-Path $env:TEMP 'dsh-dock-rect.txt') -Force -ErrorAction SilentlyContinue } catch { }
        try { Remove-Item -LiteralPath (Join-Path $env:TEMP 'dsh-dock-slot.txt') -Force -ErrorAction SilentlyContinue } catch { }
        Start-Sleep -Milliseconds 140
        $now = [DshWin]::RectOf($handle)
        # Give the window back the way it was found: if the user had minimised it,
        # minimise it again instead of leaving a full-size window on their screen.
        if ($argsIn.minimize -eq $true) {
            [DshWin]::ShowWindow([IntPtr]$handle, 6) | Out-Null
            Start-Sleep -Milliseconds 80
        }
        return [ordered]@{ action = 'restore'; handle = $handle; rect = @{ x = $now[0]; y = $now[1]; width = $now[2]; height = $now[3] } }
    }

    $stateFile = Join-Path $env:TEMP 'dsh-dock-rect.txt'
    $slotFile = Join-Path $env:TEMP 'dsh-dock-slot.txt'
    if ([DshWin]::IsIconic([IntPtr]$handle)) { [DshWin]::ShowWindow([IntPtr]$handle, 9) | Out-Null }
    $before = [DshWin]::RectOf($handle)
    if ($null -eq $before) { throw "window $handle no longer exists" }
    if ($before[2] -ge [DshWin]::GetSystemMetrics(0) - 40) {
        # A maximised window cannot be resized, so restore it first.
        [DshWin]::ShowWindow([IntPtr]$handle, 9) | Out-Null
        Start-Sleep -Milliseconds 120
        $before = [DshWin]::RectOf($handle)
    }

    $margin = 0
    if ($null -ne $argsIn.margin) { $margin = [Math]::Min([Math]::Max([int]$argsIn.margin, 0), 200) }
    $width = 520
    if ($null -ne $argsIn.width) { $width = [Math]::Min([Math]::Max([int]$argsIn.width, 360), 1200) }
    $height = 720
    if ($null -ne $argsIn.height) { $height = [Math]::Min([Math]::Max([int]$argsIn.height, 320), 1400) }
    $screenWidth = [DshWin]::GetSystemMetrics(0)
    $screenHeight = [DshWin]::GetSystemMetrics(1)
    if ($screenWidth -lt 800) { $screenWidth = 1920 }
    if ($screenHeight -lt 600) { $screenHeight = 1080 }
    if ($height -gt $screenHeight - 40) { $height = $screenHeight - 40 }

    $x = $screenWidth - $width - $margin
    $y = $margin
    # The corner is the user's choice now: 左上/右上/左下/右下, or "custom" which
    # reuses the exact spot the panel had last time (so a dragged panel is
    # remembered instead of being snapped back to a corner).
    $corner = 'topright'
    if ($null -ne $argsIn.corner) { $corner = ([string]$argsIn.corner).ToLowerInvariant() }
    switch ($corner) {
        'topleft' { $x = $margin; $y = $margin }
        'bottomleft' { $x = $margin; $y = $screenHeight - $height - $margin }
        'bottomright' { $x = $screenWidth - $width - $margin; $y = $screenHeight - $height - $margin }
        'custom' {
            if ($null -ne $argsIn.x -and $null -ne $argsIn.y) {
                # Custom may sit on a secondary monitor, whose coordinates can be
                # negative; clamp to the virtual desktop, not to the primary one.
                $virtual = [System.Windows.Forms.SystemInformation]::VirtualScreen
                $maxX = [Math]::Max($virtual.Left, $virtual.Right - $width)
                $maxY = [Math]::Max($virtual.Top, $virtual.Bottom - $height)
                $x = [Math]::Min([Math]::Max([int]$argsIn.x, $virtual.Left), $maxX)
                $y = [Math]::Min([Math]::Max([int]$argsIn.y, $virtual.Top), $maxY)
            }
        }
        default { $x = $screenWidth - $width - $margin; $y = $margin }
    }

    # Keep the pre-dock geometry on disk: after a plugin reload the window is
    # still docked, and re-reading its current rect would make "restore" a no-op.
    #
    # "Already docked" must be judged against the rect the window actually had
    # after the last dock, not against the requested one: Windows adds frame
    # pixels, so the measured window is ~16 px wider and sits ~16 px further
    # left. Comparing the request made every redock look like a fresh window and
    # overwrote the remembered geometry with the docked rect, which is why the
    # window never came back to its old size.
    $alreadyDocked = $false
    if (Test-Path -LiteralPath $slotFile) {
        $slotParts = ((Get-Content -LiteralPath $slotFile -Raw) -replace '\s', '') -split ','
        if ($slotParts.Count -eq 4) {
            $alreadyDocked = ([Math]::Abs($before[0] - [int]$slotParts[0]) -le 4) -and
                             ([Math]::Abs($before[1] - [int]$slotParts[1]) -le 4) -and
                             ([Math]::Abs($before[2] - [int]$slotParts[2]) -le 10) -and
                             ([Math]::Abs($before[3] - [int]$slotParts[3]) -le 10)
        }
    }
    if (-not $alreadyDocked) {
        # No slot on record (fresh install while docked): a narrow window glued to
        # one of the four corners is the dock shape. This used to test the top-right
        # only, so a panel in any other corner was mistaken for the user's geometry
        # and its real size was overwritten.
        $nearTop = $before[1] -le 40
        $nearBottom = ($before[1] + $before[3]) -ge ($screenHeight - 40)
        $nearLeft = $before[0] -le 40
        $nearRight = ($before[0] + $before[2]) -ge ($screenWidth - 40)
        $alreadyDocked = ($before[2] -le 700) -and ($before[2] -ge 300) -and
                         (($nearTop -or $nearBottom) -and ($nearLeft -or $nearRight))
    }
    $saved = ('{0},{1},{2},{3}' -f $before[0], $before[1], $before[2], $before[3])
    if ($alreadyDocked -and -not (Test-Path -LiteralPath $stateFile)) {
        # Docked with no remembered geometry: pick a centred window so restore
        # still visibly puts it back instead of doing nothing.
        $fallbackWidth = [Math]::Min(1200, $screenWidth - 80)
        $fallbackHeight = [Math]::Min(800, $screenHeight - 80)
        $saved = ('{0},{1},{2},{3}' -f [int](($screenWidth - $fallbackWidth) / 2), [int](($screenHeight - $fallbackHeight) / 2), $fallbackWidth, $fallbackHeight)
        try { Set-Content -LiteralPath $stateFile -Value $saved -Encoding ASCII } catch { }
    }
    if ($alreadyDocked -and (Test-Path -LiteralPath $stateFile)) {
        $previousSaved = ((Get-Content -LiteralPath $stateFile -Raw) -replace '\s', '')
        if ($previousSaved -match '^-?\d+,-?\d+,\d+,\d+$') {
            $previousParts = $previousSaved -split ','
            # A record that equals the docked slot itself is a broken record from
            # an older build; restoring to it looks like nothing happened.
            $sameAsDock = ([Math]::Abs([int]$previousParts[0] - $before[0]) -le 4) -and
                          ([Math]::Abs([int]$previousParts[2] - $before[2]) -le 10)
            if (-not $sameAsDock) {
                $saved = $previousSaved
            } else {
                $fallbackWidth = [Math]::Min(1200, $screenWidth - 80)
                $fallbackHeight = [Math]::Min(800, $screenHeight - 80)
                $saved = ('{0},{1},{2},{3}' -f [int](($screenWidth - $fallbackWidth) / 2), [int](($screenHeight - $fallbackHeight) / 2), $fallbackWidth, $fallbackHeight)
                try { Set-Content -LiteralPath $stateFile -Value $saved -Encoding ASCII } catch { }
            }
        }
    } elseif (-not $alreadyDocked) {
        try { Set-Content -LiteralPath $stateFile -Value $saved -Encoding ASCII } catch { }
    }
    # Align the *visible* frame to the chosen corner. Windows wraps a window in an
    # invisible resize border, so positioning by the frame always leaves a gap;
    # measure the DWM frame once and offset by it. `$x`/`$y` above are the target
    # VISIBLE top-left for the selected corner, so the same correction works for
    # every corner and for a custom spot.
    $targetVisibleX = $x
    $targetVisibleY = $y
    [DshWin]::SetWindowPos([IntPtr]$handle, [IntPtr]::Zero, $targetVisibleX, $targetVisibleY, $width, $height, 0x0010 -bor 0x0040) | Out-Null
    Start-Sleep -Milliseconds 160
    $now = [DshWin]::RectOf($handle)
    $visible = [DshWin]::VisibleRectOf($handle)
    if ($null -ne $visible -and $now[2] -gt $visible[2] -and $visible[2] -gt 8) {
        $frameLeft = $visible[0] - $now[0]
        $frameTop = $visible[1] - $now[1]
        $frameWidth = $now[2] - $visible[2]
        $frameHeight = $now[3] - $visible[3]
        $x = $targetVisibleX - $frameLeft
        $y = $targetVisibleY - $frameTop
        $targetWidth = $width + $frameWidth
        $targetHeight = $height + $frameHeight
        [DshWin]::SetWindowPos([IntPtr]$handle, [IntPtr]::Zero, $x, $y, $targetWidth, $targetHeight, 0x0010 -bor 0x0040) | Out-Null
        Start-Sleep -Milliseconds 140
        $now = [DshWin]::RectOf($handle)
    }
    # Remember the slot the window really occupies, so the next dock recognises
    # it as "already docked" instead of mistaking it for the user's geometry.
    try { Set-Content -LiteralPath $slotFile -Value ('{0},{1},{2},{3}' -f $now[0], $now[1], $now[2], $now[3]) -Encoding ASCII } catch { }
    return [ordered]@{
        action = 'dock'
        handle = $handle
        saved = $saved
        wasMinimized = $wasMinimized
        rect = @{ x = $now[0]; y = $now[1]; width = $now[2]; height = $now[3] }
    }
}

function Invoke-Windows($nullArgs) {
    $windows = [DshWin]::ListWindows()
    $active = [DshWin]::Foreground()
    $list = @()
    foreach ($w in $windows) {
        $list += [ordered]@{
            handle = $w.handle
            title = $w.title
            process = (Get-ProcessNameForWindow $w.handle)
            pid = $w.pid
            x = $w.x
            y = $w.y
            width = $w.width
            height = $w.height
            active = ($w.handle -eq $active)
        }
    }
    return [ordered]@{ windows = $list; count = $list.Count }
}

function Invoke-Request($request) {
    $op = [string]$request.op
    $argsIn = $request.args
    # Everything that moves the pointer, presses a key, takes the foreground, or
    # acts on a control is input. Reading (screenshots, trees, windows) is not.
    if ($script:paused -and @('click', 'drag', 'scroll', 'type', 'key', 'uiact', 'focus', 'dock') -contains $op) {
        throw 'PAUSED: 主人按了暂停键，所有输入都被拒绝。等他放开再继续。'
    }
    switch ($op) {
        'pause' {
            $script:paused = $argsIn.on -ne $false
            return [ordered]@{ paused = $script:paused }
        }
        'ping' { return [ordered]@{ platform = 'win32'; psVersion = $PSVersionTable.PSVersion.ToString(); dpi = $dpiMode; monitors = Get-Monitors } }
        'screenshot' { return Invoke-Screenshot $argsIn }
        'monitors' {
            $list = Get-Monitors
            return [ordered]@{ monitors = $list; count = $list.Count }
        }
        'clipboard' {
            $mode = [string]$argsIn.mode
            if ($mode -eq 'set') {
                $value = [string]$argsIn.text
                Set-ClipboardText $value
                return [ordered]@{ acted = 'set'; length = $value.Length }
            }
            $current = Get-ClipboardTextSafe
            if ($null -eq $current) { return [ordered]@{ acted = 'get'; length = 0; text = ''; hasText = $false } }
            return [ordered]@{ acted = 'get'; length = $current.Length; text = $current; hasText = $true }
        }
        'windows' { return Invoke-Windows $argsIn }
        'wait' { return Invoke-Wait $argsIn }
        'dock' { return Invoke-Dock $argsIn }
        'raise' {
            $handle = [long]$argsIn.handle
            if ($handle -eq 0) { throw 'raise needs a window handle' }
            if ($argsIn.topmost -eq $false) {
                [DshWin]::SetWindowPos([IntPtr]$handle, [IntPtr](-2), 0, 0, 0, 0, 0x0001 -bor 0x0002 -bor 0x0010) | Out-Null
            } else {
                [DshWin]::SetWindowPos([IntPtr]$handle, [IntPtr](-1), 0, 0, 0, 0, 0x0001 -bor 0x0002 -bor 0x0010) | Out-Null
            }
            return [ordered]@{ raised = $handle; topmost = ($argsIn.topmost -ne $false) }
        }
        'clickthrough' {
            $handle = [long]$argsIn.handle
            if ($handle -eq 0) { throw 'clickthrough needs a window handle' }
            $enabled = $argsIn.on -ne $false
            $ok = [DshWin]::SetPanelAway($handle, [bool]$enabled)
            return [ordered]@{ handle = $handle; away = [bool]$enabled; ok = $ok }
        }
        'uitree' { return Get-UiTree ([long]$argsIn.handle) ([int]$argsIn.depth) ([int]$argsIn.limit) }
        'uiact' { return Invoke-UiAct $argsIn }
        'hit' { return Invoke-Hit $argsIn }
        'signature' { return Invoke-Signature $argsIn }
        'zoomshot' { return Invoke-ZoomShot $argsIn }
        'ocr' { return Invoke-OcrShot $argsIn }
        'windowrect' { return Invoke-WindowRect $argsIn }
        'windowshot' { return Invoke-WindowShot $argsIn }
        'focus' { return Invoke-Focus $argsIn }
        'click' {
            $panel = 0
            if ($null -ne $argsIn.panel) { $panel = [long]$argsIn.panel }
            # The panel is only slipped behind everything when the pointer really
            # lands on it, and it is restored immediately after the click.
            $away = ($panel -ne 0) -and ([DshWin]::RootAt([int]$argsIn.x, [int]$argsIn.y) -eq $panel)
            $own = Get-OwnWindowAt ([int]$argsIn.x) ([int]$argsIn.y)
            $slip = @()
            if ($away) { $slip += $panel }
            if ($own -ne 0 -and $own -ne $panel) { $slip += $own }
            foreach ($h in $slip) { [void][DshWin]::SetPanelAway($h, $true) }
            if ($slip.Count -gt 0) { Start-Sleep -Milliseconds 15 }
            try { return Invoke-Click $argsIn } finally { foreach ($h in $slip) { [void][DshWin]::SetPanelAway($h, $false) } }
        }
        'drag' {
            $panel = 0
            if ($null -ne $argsIn.panel) { $panel = [long]$argsIn.panel }
            $away = $false
            if ($panel -ne 0) {
                $away = ([DshWin]::RootAt([int]$argsIn.fromX, [int]$argsIn.fromY) -eq $panel) -or
                        ([DshWin]::RootAt([int]$argsIn.toX, [int]$argsIn.toY) -eq $panel)
            }
            $slip = @()
            if ($away) { $slip += $panel }
            foreach ($point in @(@([int]$argsIn.fromX, [int]$argsIn.fromY), @([int]$argsIn.toX, [int]$argsIn.toY))) {
                $own = Get-OwnWindowAt $point[0] $point[1]
                if ($own -ne 0 -and $slip -notcontains $own) { $slip += $own }
            }
            foreach ($h in $slip) { [void][DshWin]::SetPanelAway($h, $true) }
            if ($slip.Count -gt 0) { Start-Sleep -Milliseconds 15 }
            try { return Invoke-Drag $argsIn } finally { foreach ($h in $slip) { [void][DshWin]::SetPanelAway($h, $false) } }
        }
        'scroll' {
            $panel = 0
            if ($null -ne $argsIn.panel) { $panel = [long]$argsIn.panel }
            # Without an explicit point the wheel acts under the pointer, so that
            # is where the panel test has to look.
            $scrollX = [DshWin]::CursorX()
            $scrollY = [DshWin]::CursorY()
            $explicitPoint = ($null -ne $argsIn.x -and $null -ne $argsIn.y)
            if ($explicitPoint) {
                $scrollX = [int]$argsIn.x
                $scrollY = [int]$argsIn.y
                # Put the pointer there first: the wheel is resolved against the
                # window under it, and that must happen after the move.
                [DshWin]::MoveAbs($scrollX, $scrollY) | Out-Null
                Start-Sleep -Milliseconds 30
            }
            $away = ($panel -ne 0) -and ([DshWin]::RootAt($scrollX, $scrollY) -eq $panel)
            if ($away) {
                [void][DshWin]::SetPanelAway($panel, $true)
                Start-Sleep -Milliseconds 20
                # The wheel is routed by focus, so hand the focus to whatever the
                # panel was covering before the wheel goes out.
                $under = [DshWin]::RootAt($scrollX, $scrollY)
                if ($under -ne 0 -and $under -ne $panel) { [void][DshWin]::Focus($under) }
                Start-Sleep -Milliseconds 30
            }
            $ownScroll = Get-OwnWindowAt $scrollX $scrollY
            if ($ownScroll -ne 0 -and -not $away) {
                # 滚轮按指针下的窗口路由；压在自家卡片上时先让它穿透，滚到的就是应用。
                [void][DshWin]::SetPanelAway($ownScroll, $true)
                Start-Sleep -Milliseconds 20
            }
            try { return Invoke-Scroll $argsIn } finally {
                if ($away) { [void][DshWin]::SetPanelAway($panel, $false) }
                if ($ownScroll -ne 0 -and -not $away) { [void][DshWin]::SetPanelAway($ownScroll, $false) }
            }
        }
        'type' {
            $typed = Invoke-Type $argsIn
            $typedForeground = [DshWin]::Foreground()
            $typed.foreground = $typedForeground
            $typed.title = [DshWin]::WindowTitle($typedForeground)
            return $typed
        }
        'key' {
            $spec = [string]$argsIn.spec
            $repeat = 1
            if ($null -ne $argsIn.repeat) { $repeat = [int]$argsIn.repeat }
            Send-KeyPress $spec $repeat
            # Say where the keystroke actually landed: a key that goes to the wrong
            # window otherwise looks like the application ignoring it.
            $foreground = [DshWin]::Foreground()
            return [ordered]@{
                acted = 'key'
                spec = $spec
                repeat = $repeat
                foreground = $foreground
                title = [DshWin]::WindowTitle($foreground)
            }
        }
        'cursor' { return [ordered]@{ x = [DshWin]::CursorX(); y = [DshWin]::CursorY() } }
        default { throw "unknown operation '$op'" }
    }
}

function Write-Response($payload) {
    $script:stdoutWriter.WriteLine((ConvertTo-Json -InputObject $payload -Compress -Depth 12))
}

Write-Response ([ordered]@{ ready = $true; platform = 'win32'; dpi = $dpiMode; pid = $PID })

while ($true) {
    $line = $script:stdinReader.ReadLine()
    if ($null -eq $line) { break }
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $id = $null
    try {
        $request = ConvertFrom-Json -InputObject $line
        $id = $request.id
        $result = Invoke-Request $request
        Write-Response ([ordered]@{ id = $id; ok = $true; result = $result })
    } catch {
        $message = $_.Exception.Message
        try { Write-Response ([ordered]@{ id = $id; ok = $false; error = [ordered]@{ message = $message; code = 'HELPER_ERROR' } }) } catch { }
    }
}
