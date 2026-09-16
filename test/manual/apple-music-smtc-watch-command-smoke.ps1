# test/manual/apple-music-smtc-watch-command-smoke.ps1
#
# Live stdin/stdout check of the helper's Phase 2 command channel, without touching Apple Music: it
# starts `watch` exactly the way electron/appleMusicSmtcBridge.cjs does, sends one JSON command
# request whose --match cannot resolve to any session, and asserts that a single `response` event
# comes back with the request's id and `session-not-found`.
#
# That is the safe half of the acceptance check: it proves the request line reaches the helper, is
# parsed, is dispatched to the transport resolver, and is answered on the same stdout stream the
# snapshot events use. Sending a command that would actually control Apple Music is deliberately left
# to test/manual/verify-apple-music-smtc-electron.mjs --commands.
#
# Why PowerShell and not Node: Node's child_process with piped stdio is denied in the agent sandbox
# (spawn EPERM), while PowerShell's own pipelines are not.
#
# Usage:
#   pwsh -File test/manual/apple-music-smtc-watch-command-smoke.ps1 [-HelperPath <path>]
param(
    [string]$HelperPath = (Join-Path $PSScriptRoot '..\..\build\folia-apple-music-smtc-helper.exe')
)

$ErrorActionPreference = 'Stop'
$helper = (Resolve-Path -LiteralPath $HelperPath -ErrorAction SilentlyContinue)
if (-not $helper) {
    Write-Host "[smoke] helper not found: $HelperPath"
    Write-Host '[smoke] build and stage it, or pass -HelperPath explicitly:'
    Write-Host '[smoke]   pwsh -File test/manual/apple-music-smtc-watch-command-smoke.ps1 -HelperPath packaging/windows/apple-music-smtc-helper/target/release/folia-apple-music-smtc-helper.exe'
    exit 1
}

$failures = 0
function Assert($label, $condition, $detail = '') {
    if ($condition) {
        Write-Host "  ok   $label"
        return
    }
    $script:failures += 1
    Write-Host "  FAIL $label$(if ($detail) { " - $detail" })"
}

$requestId = 'smoke-1'
$startInfo = [System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $helper.Path
$startInfo.Arguments = 'watch --interval 300 --heartbeat 1000 --match ZZZNoSuchPlayer'
$startInfo.RedirectStandardInput = $true
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true

$process = [System.Diagnostics.Process]::Start($startInfo)
$events = @()

try {
    # `ready` is the first line by construction (see run_windows in main.rs).
    $line = $process.StandardOutput.ReadLine()
    if ($line) { $events += ($line | ConvertFrom-Json) }

    $process.StandardInput.WriteLine('{"id":"' + $requestId + '","command":"play"}')
    $process.StandardInput.Flush()

    # Read until the response arrives; heartbeats may legitimately interleave with it.
    $deadline = (Get-Date).AddSeconds(15)
    while ((Get-Date) -lt $deadline) {
        $line = $process.StandardOutput.ReadLine()
        if ($null -eq $line) { break }
        $parsed = $line | ConvertFrom-Json
        $events += $parsed
        if ($parsed.event -eq 'response') { break }
    }

    $process.StandardInput.WriteLine('stop')
    $process.StandardInput.Flush()
    $process.WaitForExit(10000) | Out-Null
}
finally {
    if (-not $process.HasExited) { $process.Kill() }
}

$ready = $events | Where-Object { $_.event -eq 'ready' } | Select-Object -First 1
$response = $events | Where-Object { $_.event -eq 'response' } | Select-Object -First 1
$heartbeats = @($events | Where-Object { $_.event -eq 'heartbeat' })

Assert 'the helper announced ready' ($null -ne $ready)
Assert 'a response event came back' ($null -ne $response) ($events | ConvertTo-Json -Compress)
Assert 'the response echoes the request id' ($response.id -eq $requestId) ($response | ConvertTo-Json -Compress)
Assert 'the response reports failure' ($response.ok -eq $false)
Assert 'the kind is session-not-found' ($response.errorKind -eq 'session-not-found') $response.errorKind
Assert 'no target is claimed' ($null -eq $response.targetAppUserModelId)
Assert 'the process exited cleanly after stop' ($process.ExitCode -eq 0) "exit=$($process.ExitCode)"

Write-Host ''
if ($failures -eq 0) {
    Write-Host '[smoke] OK'
    exit 0
}
Write-Host "[smoke] $failures check(s) failed"
exit 1
