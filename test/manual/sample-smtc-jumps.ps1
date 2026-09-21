param(
    # Substring match against SourceAppUserModelId.
    [string]$Match = 'AppleMusicWin',
    # Target sampling period. Below ~20 ms the WinRT properties call itself dominates the loop, and
    # the measured cadence reported at the end is what the statistics actually used.
    [ValidateRange(5, 5000)]
    [int]$IntervalMs = 25,
    [ValidateRange(10, 3600)]
    [int]$Seconds = 90,
    [string]$OutDir = ''
)

# test/manual/sample-smtc-jumps.ps1
#
# Phase-stability probe for the SMTC Position integer jump. Answers one question:
#
#     Do the observed N*1000 -> (N+1)*1000 Position jumps occur at a stable period, so a local
#     monotonic clock could be anchored on a jump and advanced freely until the next one?
#
# This is deliberately NOT the same measurement as analyze-smtc-timeline.py. That script compared a
# locally extrapolated clock against the reported Position, which measures the reported Position's
# own quantization lag, not the accuracy of a local clock. Here the reported Position value is used
# ONLY as an edge trigger - its magnitude is never treated as a time. The quantity under test is the
# interval between consecutive edges, measured entirely with the machine's monotonic clock.
#
# Read-only: issues no Try* command. LastUpdatedTime is recorded but explicitly not used as an
# anchor, per the experiment design.
#
# Windows PowerShell 5.1 is required (not pwsh 7): only the Desktop edition projects the Windows
# Runtime media-control types. When launched from PowerShell 7 the script re-execs itself under 5.1.

$ErrorActionPreference = 'Stop'

if ($PSVersionTable.PSEdition -ne 'Desktop') {
    $windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (-not (Test-Path -LiteralPath $windowsPowerShell)) {
        throw 'Windows PowerShell 5.1 was not found; it is required to access the SMTC WinRT API.'
    }

    $forwardedArguments = @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', $PSCommandPath,
        '-Match', $Match,
        '-IntervalMs', [string]$IntervalMs,
        '-Seconds', [string]$Seconds
    )
    if ($OutDir) { $forwardedArguments += @('-OutDir', $OutDir) }

    & $windowsPowerShell @forwardedArguments
    exit $LASTEXITCODE
}

Add-Type -AssemblyName System.Runtime.WindowsRuntime

$managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$asTaskMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object {
        $_.Name -eq 'AsTask' -and
        $_.IsGenericMethodDefinition -and
        $_.GetGenericArguments().Count -eq 1 -and
        $_.GetParameters().Count -eq 1
    } |
    Select-Object -First 1

if (-not $asTaskMethod) {
    throw 'Could not locate the Windows Runtime AsTask adapter.'
}

function Wait-WinRtResult {
    param(
        [Parameter(Mandatory = $true)]$Operation,
        [Parameter(Mandatory = $true)][Type]$ResultType
    )

    $task = $script:asTaskMethod.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
    return $task.GetAwaiter().GetResult()
}

function Get-OptionalTotalMs {
    param([Parameter(Mandatory = $true)][scriptblock]$Read)

    try {
        $value = & $Read
        if ($null -eq $value) { return '' }
        return [math]::Round($value.TotalMilliseconds, 3)
    } catch {
        return ''
    }
}

if (-not $OutDir) { $OutDir = (Get-Location).Path }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$manager = Wait-WinRtResult -Operation $managerType::RequestAsync() -ResultType $managerType
$sessions = @($manager.GetSessions())
$currentSession = $manager.GetCurrentSession()
$currentSourceAppId = if ($currentSession) { [string]$currentSession.SourceAppUserModelId } else { $null }

Write-Output '=== SMTC session inventory ==='
Write-Output ('CurrentSession = {0}' -f $(if ($currentSourceAppId) { $currentSourceAppId } else { '<none>' }))
foreach ($session in $sessions) {
    Write-Output ('  {0,-56} current={1}' -f [string]$session.SourceAppUserModelId, ($session.SourceAppUserModelId -eq $currentSourceAppId).ToString().ToLowerInvariant())
}

$target = @($sessions | Where-Object { $_.SourceAppUserModelId -like ('*' + $Match + '*') }) | Select-Object -First 1
if (-not $target) {
    Write-Output ('No session matched -Match ''{0}''. Nothing sampled.' -f $Match)
    exit 2
}

$targetSourceAppId = [string]$target.SourceAppUserModelId
Write-Output ''
Write-Output ('=== sampling jump phase on {0} ===' -f $targetSourceAppId)
Write-Output ('isCurrentSession = {0}' -f ($targetSourceAppId -eq $currentSourceAppId).ToString().ToLowerInvariant())
Write-Output ('target interval = {0} ms, duration = {1} s' -f $IntervalMs, $Seconds)

$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
$csvPath = Join-Path $OutDir ("smtc-jumps-$stamp.csv")
$jsonPath = Join-Path $OutDir ("smtc-jumps-$stamp.json")

# Stopwatch is the monotonic source: it is unaffected by wall-clock adjustments, which is exactly
# the property a lyric clock would depend on.
$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$rows = New-Object System.Collections.Generic.List[object]
$deadlineStopwatchMs = $Seconds * 1000.0
$index = 0

while ($stopwatch.Elapsed.TotalMilliseconds -lt $deadlineStopwatchMs) {
    $loopStopwatchMs = $stopwatch.Elapsed.TotalMilliseconds
    $playbackInfo = $target.GetPlaybackInfo()
    $timeline = $target.GetTimelineProperties()

    $rows.Add([pscustomobject]@{
        index              = $index
        stopwatchMs        = [math]::Round($loopStopwatchMs, 3)
        epochMs            = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        playbackStatus     = [string]$playbackInfo.PlaybackStatus
        positionMs         = Get-OptionalTotalMs { $timeline.Position }
        endTimeMs          = Get-OptionalTotalMs { $timeline.EndTime }
        lastUpdatedEpochMs = [DateTimeOffset]::new($timeline.LastUpdatedTime.UtcDateTime).ToUnixTimeMilliseconds()
    })

    $index++
    Start-Sleep -Milliseconds $IntervalMs
}

$stopwatch.Stop()
$rows | Export-Csv -Path $csvPath -NoTypeInformation -Encoding UTF8

$summary = [pscustomobject]@{
    sourceAppUserModelId = $targetSourceAppId
    sampledAt            = (Get-Date).ToString('o')
    targetIntervalMs     = $IntervalMs
    requestedSeconds     = $Seconds
    sampleCount          = $rows.Count
    observedSeconds      = [math]::Round(($rows[$rows.Count - 1].stopwatchMs - $rows[0].stopwatchMs) / 1000, 3)
    observedIntervalMs   = [math]::Round(($rows[$rows.Count - 1].stopwatchMs - $rows[0].stopwatchMs) / [math]::Max(1, $rows.Count - 1), 3)
    csvPath              = $csvPath
}
$summary | ConvertTo-Json -Depth 5 | Set-Content -Path $jsonPath -Encoding UTF8

Write-Output ''
Write-Output '=== raw summary ==='
$summary | Format-List
Write-Output ('CSV  : {0}' -f $csvPath)
Write-Output ('JSON : {0}' -f $jsonPath)
