# Helpers to drive a window of the user's running Brave (or Chrome) and record it with ffmpeg gdigrab.
# The browser session is used as is: no cookies, passwords or tokens are read, copied or printed.
# Every keystroke is preceded by a check that the demo window has the focus; otherwise the run stops,
# so input can never land in another application.
Set-StrictMode -Version Latest

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
if (-not ('DemoWin32' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class DemoWin32 {
    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc proc, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, int data, UIntPtr extra);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);

    public static List<IntPtr> BrowserWindows(uint[] pids) {
        var result = new List<IntPtr>();
        var set = new HashSet<uint>(pids);
        EnumWindows((h, l) => {
            if (!IsWindowVisible(h)) return true;
            uint pid; GetWindowThreadProcessId(h, out pid);
            if (!set.Contains(pid)) return true;
            var cls = new StringBuilder(64); GetClassName(h, cls, 64);
            if (cls.ToString() == "Chrome_WidgetWin_1" && Title(h).Length > 0) result.Add(h);
            return true;
        }, IntPtr.Zero);
        return result;
    }
    public static string Title(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
}
'@
}
# Per-monitor DPI awareness: coordinates and captures are physical pixels on every monitor.
[void][DemoWin32]::SetProcessDpiAwarenessContext([IntPtr]-4)

$script:Window = [IntPtr]::Zero
$script:Browser = $null
$script:Bounds = $null

function Get-DemoBrowser {
    foreach ($name in 'brave', 'chrome', 'msedge') {
        $procs = @(Get-Process $name -ErrorAction SilentlyContinue)
        $main = $procs | Where-Object { $_.Path } | Select-Object -First 1
        if ($main) { return [pscustomobject]@{ Name = $name; Path = $main.Path; Pids = [uint32[]]@($procs.Id) } }
    }
    throw 'No running Brave, Chrome or Edge found. Start your browser (already signed in) and run again.'
}

function Get-DemoMonitor([string]$Which) {
    $screens = [System.Windows.Forms.Screen]::AllScreens
    $screen = if ($Which -eq 'secondary') { $screens | Where-Object { -not $_.Primary } | Select-Object -First 1 } else { $null }
    if (-not $screen) { $screen = [System.Windows.Forms.Screen]::PrimaryScreen }
    $b = $screen.Bounds
    if ($b.Width -ne 1920 -or $b.Height -ne 1080) { throw "Monitor $($screen.DeviceName) is $($b.Width)x$($b.Height); a 1920x1080 monitor is required." }
    return $b
}

function Assert-DemoFocus {
    if (-not [DemoWin32]::IsWindow($script:Window)) { throw 'The demo browser window was closed; stopping.' }
    if ([DemoWin32]::GetForegroundWindow() -ne $script:Window) {
        # One attempt to take the focus back (Alt makes Windows accept SetForegroundWindow).
        [DemoWin32]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [DemoWin32]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
        [void][DemoWin32]::SetForegroundWindow($script:Window)
        Start-Sleep -Milliseconds 400
        if ([DemoWin32]::GetForegroundWindow() -ne $script:Window) {
            throw 'Another window took the focus; stopping so no keystroke goes elsewhere. Do not use the keyboard or mouse during the capture.'
        }
    }
}

function Open-DemoWindow([string]$Monitor = 'primary') {
    $script:Browser = Get-DemoBrowser
    $bounds = Get-DemoMonitor $Monitor
    $before = [DemoWin32]::BrowserWindows($script:Browser.Pids)
    # Handing a URL to the running browser opens a window in the existing session; it is not a new browser.
    Start-Process -FilePath $script:Browser.Path -ArgumentList '--new-window', 'about:blank'
    $deadline = (Get-Date).AddSeconds(15)
    do {
        Start-Sleep -Milliseconds 300
        $script:Browser = Get-DemoBrowser
        $new = @([DemoWin32]::BrowserWindows($script:Browser.Pids) | Where-Object { $before -notcontains $_ })
    } until ($new.Count -gt 0 -or (Get-Date) -gt $deadline)
    if ($new.Count -eq 0) { throw 'The browser did not open a new window.' }
    $script:Window = $new[0]
    [void][DemoWin32]::ShowWindow($script:Window, 9)
    [void][DemoWin32]::SetWindowPos($script:Window, [IntPtr]::Zero, $bounds.X + 100, $bounds.Y + 100, 1200, 800, 0x0040)
    Start-Sleep -Milliseconds 300
    [void][DemoWin32]::ShowWindow($script:Window, 3)
    Start-Sleep -Milliseconds 500
    $script:Bounds = $bounds
    Set-DemoFullScreen
    return $bounds
}

function Test-DemoFullScreen {
    # Full screen covers exactly the monitor; a maximized window is offset by its frame and stops at the taskbar.
    $r = New-Object DemoWin32+RECT
    [void][DemoWin32]::GetWindowRect($script:Window, [ref]$r)
    return ($r.Left -eq $script:Bounds.X -and $r.Top -eq $script:Bounds.Y -and
        ($r.Right - $r.Left) -eq $script:Bounds.Width -and ($r.Bottom - $r.Top) -eq $script:Bounds.Height)
}

function Set-DemoFullScreen {
    for ($i = 0; $i -lt 2 -and -not (Test-DemoFullScreen); $i++) {
        Assert-DemoFocus
        Send-DemoKey 'F11'
        # Wait until the browser's "press Esc to exit full screen" notice has faded out.
        Start-Sleep -Seconds 5
    }
    if (-not (Test-DemoFullScreen)) { throw 'The demo window could not be switched to full screen.' }
}

function Close-DemoWindow {
    if ($script:Window -ne [IntPtr]::Zero -and [DemoWin32]::IsWindow($script:Window)) {
        Assert-DemoFocus
        Send-DemoKey 'F11'
        Start-Sleep -Milliseconds 500
        [System.Windows.Forms.SendKeys]::SendWait('^+w')   # closes this window only (all its tabs)
    }
    $script:Window = [IntPtr]::Zero
}

$script:VirtualKeys = @{ F11 = 0x7A; Escape = 0x1B; Enter = 0x0D; Home = 0x24; End = 0x23; PageDown = 0x22; Down = 0x28 }

function Send-DemoKey([string]$Key) {
    Assert-DemoFocus
    $vk = [byte]$script:VirtualKeys[$Key]
    [DemoWin32]::keybd_event($vk, 0, 0, [UIntPtr]::Zero)
    [DemoWin32]::keybd_event($vk, 0, 2, [UIntPtr]::Zero)
}

function ConvertTo-SendKeysText([string]$Text) {
    return [regex]::Replace($Text, '[+^%~(){}\[\]]', { param($m) '{' + $m.Value + '}' })
}

function Get-DemoTitle { return [DemoWin32]::Title($script:Window) }

function Wait-DemoTitle([string]$Pattern, [int]$TimeoutSeconds = 30) {
    $start = Get-Date
    $deadline = $start.AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $title = [DemoWin32]::Title($script:Window)
        if ($title -match $Pattern) { return $title }
        if ($title -match '^(Log in|Sign in)\b' -and ((Get-Date) - $start).TotalSeconds -gt 6) { throw "Not signed in: '$title'." }
        Start-Sleep -Milliseconds 300
    }
    throw "Page title '$([DemoWin32]::Title($script:Window))' did not match '$Pattern' (signed out, or the service is down?)."
}

function Open-DemoUrl([string]$Url, [string]$TitlePattern, [double]$Settle = 2.5) {
    # The running browser opens the URL as a new tab in its last focused window, which is the demo window.
    Assert-DemoFocus
    Start-Process -FilePath $script:Browser.Path -ArgumentList $Url
    Start-Sleep -Milliseconds 800
    Assert-DemoFocus
    $title = Wait-DemoTitle $TitlePattern
    if ($title -match '^(Sign in|Log in|Login)\b|Sign in \[Jenkins\]') { throw "Not signed in: '$title'. Sign in in your browser and run again." }
    Set-DemoFullScreen
    Start-Sleep -Milliseconds ([int]($Settle * 1000))
    return $title
}

function Find-DemoText([string]$Text) {
    Assert-DemoFocus
    [System.Windows.Forms.SendKeys]::SendWait('^f')
    Start-Sleep -Milliseconds 400
    Assert-DemoFocus
    [System.Windows.Forms.SendKeys]::SendWait((ConvertTo-SendKeysText $Text))
    Start-Sleep -Milliseconds 700
    Send-DemoKey 'Escape'   # closes the find bar; the match stays selected and scrolled into view
    Start-Sleep -Milliseconds 300
}

function Get-DemoContentBounds([System.Drawing.Rectangle]$Bounds, [int]$Inset) {
    # Brave draws a thin frame around a full-screen window; captures use the area inside it.
    return New-Object System.Drawing.Rectangle ($Bounds.X + $Inset), ($Bounds.Y + $Inset), ($Bounds.Width - 2 * $Inset), ($Bounds.Height - 2 * $Inset)
}

function Invoke-DemoScroll([System.Drawing.Rectangle]$Bounds, [int]$Notches, [int]$IntervalMs = 140) {
    # Wheel input goes to the window under the cursor: park the cursor in the demo window (hidden in the video).
    Assert-DemoFocus
    [void][DemoWin32]::SetCursorPos($Bounds.X + [int]($Bounds.Width * 0.78), $Bounds.Y + [int]($Bounds.Height * 0.55))
    $delta = if ($Notches -lt 0) { 120 } else { -120 }
    for ($i = 0; $i -lt [math]::Abs($Notches); $i++) {
        Assert-DemoFocus
        [DemoWin32]::mouse_event(0x0800, 0, 0, $delta, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds $IntervalMs
    }
}

function Save-DemoScreenshot([System.Drawing.Rectangle]$Bounds, [string]$Path) {
    $bitmap = New-Object System.Drawing.Bitmap $Bounds.Width, $Bounds.Height
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.CopyFromScreen($Bounds.X, $Bounds.Y, 0, 0, $bitmap.Size)
        $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    finally { $graphics.Dispose(); $bitmap.Dispose() }
}

function Start-DemoRecording([string]$Ffmpeg, [System.Drawing.Rectangle]$Bounds, [string]$Path) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo $Ffmpeg
    $psi.Arguments = "-hide_banner -loglevel error -y -f gdigrab -framerate 30 -draw_mouse 0 " +
        "-offset_x $($Bounds.X) -offset_y $($Bounds.Y) -video_size $($Bounds.Width)x$($Bounds.Height) -i desktop " +
        "-c:v libx264 -preset ultrafast -crf 14 -pix_fmt yuv420p `"$Path`""
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.CreateNoWindow = $true
    $process = [System.Diagnostics.Process]::Start($psi)
    Start-Sleep -Milliseconds 900
    return $process
}

function Stop-DemoRecording([System.Diagnostics.Process]$Process) {
    $Process.StandardInput.Write('q')
    $Process.StandardInput.Close()
    if (-not $Process.WaitForExit(20000)) { $Process.Kill(); throw 'ffmpeg did not stop.' }
}

Export-ModuleMember -Function *-Demo*, ConvertTo-SendKeysText
