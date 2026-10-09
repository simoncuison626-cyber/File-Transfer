<#
.SYNOPSIS
    Runs the Beam file-transfer site on this machine and prints the address to
    open on your phone.

.DESCRIPTION
    Serves the site in this folder over HTTP, opens a firewall rule so the phone
    can reach it, and prints a URL you type into Safari on the iPhone.

    The server runs inside this PowerShell process, so closing the window always
    stops it - there is no background process left behind.

    Needs Administrator once, because Windows will not let a normal account bind
    a server to the network or add a firewall rule. Everything it changes is
    listed under -CleanFirewall.

.PARAMETER Port
    Port to serve on. If it is busy, the next free port is used.

.PARAMETER NoBrowser
    Do not open the site in the default browser.

.PARAMETER CleanFirewall
    Remove the firewall rule this script created, then exit.

.PARAMETER SelfTest
    Start, fetch the site over the LAN address, print the result and stop again.

.EXAMPLE
    .\Start-Beam.ps1
    .\Start-Beam.ps1 -Port 9000
    .\Start-Beam.ps1 -SelfTest
#>
[CmdletBinding()]
param(
    [int]    $Port = 8000,
    [switch] $NoBrowser,
    [switch] $CleanFirewall,
    [switch] $SelfTest
)

$ErrorActionPreference = 'Stop'
$siteRoot   = $PSScriptRoot
$ruleName   = 'Beam local test'
$startedAt  = Get-Date

# ----------------------------------------------------------------- output --

function Write-Section { param([string]$Text) Write-Host ''; Write-Host "== $Text" -ForegroundColor Cyan }
function Write-Ok      { param([string]$Text) Write-Host "   [ok]   $Text" -ForegroundColor Green }
function Write-Info    { param([string]$Text) Write-Host "   [info] $Text" -ForegroundColor Gray }
function Write-Warn    { param([string]$Text) Write-Host "   [warn] $Text" -ForegroundColor Yellow }
function Write-Bad     { param([string]$Text) Write-Host "   [!!]   $Text" -ForegroundColor Red }

function Stop-WithError {
    param([string]$Text)
    Write-Host ''
    Write-Bad $Text
    Write-Host ''
    if (-not $SelfTest) { Read-Host '   Press Enter to close' | Out-Null }
    exit 1
}

# ---------------------------------------------------------------- helpers --

function Test-IsAdmin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal $id).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-RuleName { param([int]$ForPort) "$ruleName TCP $ForPort" }

function Remove-OurFirewallRules {
    $rules = @(Get-NetFirewallRule -ErrorAction SilentlyContinue |
               Where-Object { $_.DisplayName -like "$ruleName*" })
    if ($rules.Count -eq 0) { Write-Info 'No Beam firewall rules found.'; return }
    if (-not (Test-IsAdmin)) {
        Write-Warn 'Removing the rule needs Administrator. Re-run Start-Beam.cmd as Administrator, or paste this into an elevated PowerShell:'
        Write-Host ''
        Write-Host "         Get-NetFirewallRule -DisplayName '$ruleName*' | Remove-NetFirewallRule" -ForegroundColor White
        Write-Host ''
        return
    }
    foreach ($r in $rules) { Remove-NetFirewallRule -DisplayName $r.DisplayName -ErrorAction SilentlyContinue }
    Write-Ok "Removed $($rules.Count) firewall rule(s)."
}

function Invoke-Elevated {
    # Runs one command as Administrator, waits for it, reports success.
    param([string]$Command)
    try {
        $p = Start-Process -FilePath 'powershell.exe' `
             -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $Command `
             -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ErrorAction Stop
        return ($p.ExitCode -eq 0)
    } catch { return $false }
}

function Ensure-FirewallRule {
    param([int]$ForPort)
    $name = Get-RuleName -ForPort $ForPort

    if (Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue) {
        Write-Ok "Firewall already allows inbound TCP $ForPort."
        return $true
    }

    $cmd = "New-NetFirewallRule -DisplayName '$name' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $ForPort -Profile Private,Domain | Out-Null"
    if (Test-IsAdmin) {
        try {
            # Called directly rather than via Invoke-Expression, so there is no
            # string-eval sink here at all.
            New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow `
                -Protocol TCP -LocalPort $ForPort -Profile Private,Domain -ErrorAction Stop | Out-Null
            Write-Ok "Firewall rule added for TCP $ForPort."
            return $true
        } catch {
            Write-Warn "Could not add the firewall rule: $($_.Exception.Message)"
            return $false
        }
    }

    Write-Info 'Adding a firewall rule needs Administrator - a prompt will appear.'
    if (Invoke-Elevated -Command $cmd) {
        Write-Ok "Firewall rule added for TCP $ForPort."
        return $true
    }
    Write-Warn 'No firewall rule was added, so a phone may not be able to connect.'
    return $false
}

function Get-FreePort {
    param([int]$Preferred)
    $busy = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners().Port
    if ($busy -notcontains $Preferred) { return $Preferred }
    for ($p = $Preferred + 1; $p -le ($Preferred + 50); $p++) {
        if ($busy -notcontains $p) { return $p }
    }
    Stop-WithError "No free port found near $Preferred."
}

function Get-LanAddress {
    # Use the adapter that carries the default route, so a VPN or virtual
    # adapter never wins over the real Wi-Fi / Ethernet one.
    $virtualWords = 'hyper-v|virtual|tunnel|vpn|wintun|vmware|virtualbox|loopback|pseudo|bluetooth'
    $candidates = @()

    $routes = @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
                Sort-Object -Property RouteMetric, InterfaceMetric)

    foreach ($r in $routes) {
        $adapter = Get-NetAdapter -InterfaceIndex $r.InterfaceIndex -ErrorAction SilentlyContinue
        if (-not $adapter) { continue }
        if ((('{0} {1}' -f $adapter.Name, $adapter.InterfaceDescription) -match $virtualWords)) { continue }
        if ($adapter.Status -and $adapter.Status -ne 'Up') { continue }

        $addr = Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $r.InterfaceIndex -ErrorAction SilentlyContinue |
                Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
                Select-Object -First 1
        if ($addr) {
            $candidates += [pscustomobject]@{
                Address = $addr.IPAddress
                Adapter = $adapter.Name
                Metric  = [int]$r.RouteMetric + [int]$r.InterfaceMetric
            }
        }
    }

    if ($candidates.Count -eq 0) {
        $fallback = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
            Where-Object {
                $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and
                $_.IPAddress -match '^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)'
            } | Select-Object -First 1
        if ($fallback) { return $fallback.IPAddress }
        return $null
    }

    return ($candidates | Sort-Object Metric | Select-Object -First 1).Address
}

$mime = @{
    '.html'        = 'text/html; charset=utf-8'
    '.js'          = 'text/javascript; charset=utf-8'
    '.css'         = 'text/css; charset=utf-8'
    '.svg'         = 'image/svg+xml'
    '.png'         = 'image/png'
    '.jpg'         = 'image/jpeg'
    '.webmanifest' = 'application/manifest+json'
    '.json'        = 'application/json'
    '.txt'         = 'text/plain; charset=utf-8'
}

# The request loop has to run on its own thread, otherwise GetContext() blocks
# and nothing else can happen. It runs in a runspace rather than a child
# process, so closing this window still stops the server.
$serveWorker = {
    param($Listener, $Root, $Mime)

    # Compare against the root *plus a trailing separator*, otherwise a sibling
    # folder such as "File Transfer-secret" would pass a plain StartsWith test.
    $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'

    while ($true) {
        try {
            if (-not $Listener.IsListening) { break }
            $context = $Listener.GetContext()
        } catch [System.ObjectDisposedException] {
            break
        } catch [System.Net.HttpListenerException] {
            continue   # one bad connection must not take the whole server down
        } catch {
            break
        }

        $response = $context.Response
        try {
            $rel = [Uri]::UnescapeDataString($context.Request.Url.AbsolutePath).TrimStart('/')
            if ($rel -eq '') { $rel = 'index.html' }

            # Refuse anything that could reach outside the site folder, and
            # refuse dot-files so .git and friends are never served.
            $blocked = $false
            foreach ($seg in ($rel -split '[\\/]')) {
                if ($seg -eq '') { continue }
                if ($seg.StartsWith('.')) { $blocked = $true; break }
            }
            if ($blocked) {
                $response.StatusCode = 403
            } else {
                $full = [System.IO.Path]::GetFullPath((Join-Path $Root $rel))
                if (-not $full.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
                    $response.StatusCode = 403
                } elseif (Test-Path -LiteralPath $full -PathType Leaf) {
                    $bytes = [System.IO.File]::ReadAllBytes($full)
                    $ext   = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
                    $type  = 'application/octet-stream'
                    if ($Mime.ContainsKey($ext)) { $type = $Mime[$ext] }
                    $response.StatusCode     = 200
                    $response.ContentType    = $type
                    $response.ContentLength64 = $bytes.Length
                    $response.OutputStream.Write($bytes, 0, $bytes.Length)
                } else {
                    $response.StatusCode = 404
                }
            }
        } catch {
            try { $response.Abort() } catch { }
        } finally {
            try { $response.Close() } catch { }
        }
    }
}

function Start-ServeLoop {
    param($Listener, [string]$Root, $MimeMap)

    $rs = [runspacefactory]::CreateRunspace()
    $rs.Open()
    $ps = [powershell]::Create()
    $ps.Runspace = $rs

    # AddScript + AddArgument, because PowerShell.BeginInvoke has no overload
    # that takes arguments and a script together.
    $null = $ps.AddScript($serveWorker)
    $null = $ps.AddArgument($Listener)
    $null = $ps.AddArgument($Root)
    $null = $ps.AddArgument($MimeMap)

    $handle = $ps.BeginInvoke()
    return @{ Runspace = $rs; Shell = $ps; Handle = $handle }
}

# --------------------------------------------------------------- cleanup ---

if ($CleanFirewall) {
    Write-Section 'Firewall cleanup'
    Remove-OurFirewallRules
    exit 0
}

# ------------------------------------------------------------------ start --

Write-Host ''
Write-Host '  transferfile.com - local file transfer' -ForegroundColor White
Write-Host '  --------------------------------------' -ForegroundColor DarkGray

if (-not (Test-Path -LiteralPath (Join-Path $siteRoot 'index.html'))) {
    Stop-WithError "index.html was not found next to this script.`n   Looked in: $siteRoot"
}
Write-Ok "Site folder: $siteRoot"

Write-Section 'Environment'
$lan = Get-LanAddress
if ($lan) {
    Write-Ok "LAN address: $lan  (this is what the phone will use)"
} else {
    Write-Warn 'No LAN address found. Connect to Wi-Fi or Ethernet.'
}

$port = Get-FreePort -Preferred $Port
if ($port -ne $Port) {
    Write-Warn "Port $Port is busy, using $port instead."
} else {
    Write-Ok "Port: $port"
}

# Do the firewall work BEFORE opening the socket. If the listener is bound but
# nothing is serving yet, a phone that connects in that window waits forever and
# Safari shows a blank page - which looks like a black screen with no error.
$firewallOk = Ensure-FirewallRule -ForPort $port

# Bind only to the address the phone will use, plus loopback. Never "+", which
# would also answer on public interfaces (cafe wifi, a public IP) and expose the
# whole folder.
$listener = New-Object System.Net.HttpListener
$bindList = New-Object System.Collections.Generic.List[string]
if ($lan) { $bindList.Add("http://${lan}:$port/") }
$bindList.Add("http://127.0.0.1:$port/")
foreach ($p in $bindList) { $listener.Prefixes.Add($p) }

try {
    $listener.Start()
    Write-Ok "Listening on $($bindList -join ' and ')"
} catch {
    Stop-WithError "Windows refused to open the server on port $port.`n   $($_.Exception.Message)`n`n   Binding a network server needs Administrator.`n   Close this window, then right-click Start-Beam.cmd and choose 'Run as administrator'."
}

$target = if ($lan) { "http://${lan}:$port/" } else { "http://127.0.0.1:$port/" }
$serving = Start-ServeLoop -Listener $listener -Root $siteRoot -MimeMap $mime

# Make sure it really answers before printing the address.
$ready = $false
$lastError = ''
for ($i = 0; $i -lt 20; $i++) {
    try {
        $probe = Invoke-WebRequest -Uri $target -TimeoutSec 2 -UseBasicParsing
        if ($probe.StatusCode -eq 200) { $ready = $true; break }
    } catch { $lastError = $_.Exception.Message; Start-Sleep -Milliseconds 250 }
}
if (-not $ready) {
    try { $listener.Stop() } catch { }
    Stop-WithError "The server did not answer on $target.`n   $lastError"
}
Write-Ok "Site is live on $target"

try { Set-Clipboard -Value $target } catch { }

# ------------------------------------------------------------------ serve --

Write-Section 'Open this on your phone'
Write-Host ''
Write-Host '        ' -NoNewline
Write-Host $target -ForegroundColor Black -BackgroundColor Cyan -NoNewline
Write-Host ''
Write-Host ''
Write-Host '        (copied to the clipboard)' -ForegroundColor DarkGray
Write-Host ''

if ($SelfTest) {
    $results = @()
    foreach ($path in @('/', '/assets/app.js', '/assets/net.js', '/assets/vendor/peerjs.min.js', '/assets/vendor/qrcode-generator.js', '/assets/icon-192.png', '/manifest.webmanifest')) {
        try {
            $r = Invoke-WebRequest -Uri ($target.TrimEnd('/') + $path) -TimeoutSec 5 -UseBasicParsing
            $results += [pscustomobject]@{ Path = $path; Code = $r.StatusCode; Bytes = $r.RawContentLength }
        } catch {
            $results += [pscustomobject]@{ Path = $path; Code = 'ERR'; Bytes = 0 }
        }
    }

    Write-Section 'Self test'
    foreach ($r in $results) {
        if ($r.Code -eq 200) { Write-Ok ("{0,-42} {1,8:N0} bytes" -f $r.Path, $r.Bytes) }
        else                 { Write-Bad ("{0,-42} {1}" -f $r.Path, $r.Code) }
    }
    $badCount = @($results | Where-Object { $_.Code -ne 200 }).Count
    if ($badCount -gt 0)            { Write-Host ''; Write-Bad "$badCount resource(s) failed."; }
    elseif (-not $firewallOk)       { Write-Host ''; Write-Warn 'Firewall rule missing - a phone may not reach this.' }
    else                            { Write-Host ''; Write-Ok 'PASS - the phone should be able to reach this now.' }

    $listener.Stop()
    try { $serving.Shell.Dispose(); $serving.Runspace.Close() } catch { }
    Write-Host ''
    Write-Info 'Stopped.'
    exit $(if ($badCount -gt 0) { 1 } else { 0 })
}

if (-not $NoBrowser) {
    Start-Process $target -ErrorAction SilentlyContinue
    Write-Info 'Opened in your browser.'
}

Write-Section 'Running'
Write-Host '   On the phone: open Safari, go to the address above, then type in' -ForegroundColor Gray
Write-Host '   the 6-digit code shown on this screen.' -ForegroundColor Gray
Write-Host ''
Write-Host '   Close this window (or press Ctrl+C) to stop the server.' -ForegroundColor Yellow
Write-Host ''

try {
    # Block until the serve loop ends (listener stopped) or the user interrupts.
    while ($true) {
        if ($serving.Handle.IsCompleted) { break }
        Start-Sleep -Milliseconds 500
    }
} catch [System.Management.Automation.HostException] {
    # Ctrl+C
} catch {
    # Window closed, or any other shutdown.
} finally {
    # Closing this window ends the process, and Windows releases the http.sys
    # registration with it - so there is nothing left listening on the LAN.
    try { $listener.Stop() } catch { }
}

# --------------------------------------------------------------- finished --

Write-Host ''
if ($startedAt) {
    $ran = (Get-Date) - $startedAt
    Write-Info ("Stopped after {0:hh\:mm\:ss}." -f $ran)
}
Write-Host '   To remove the firewall rule:' -ForegroundColor DarkGray
Write-Host '     .\Start-Beam.ps1 -CleanFirewall' -ForegroundColor DarkGray
Write-Host ''