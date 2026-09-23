param(
    # Substring match against SourceAppUserModelId. The default targets the Chrome tab playing
    # music.apple.com (the external-media backend's media source).
    [string]$Match = 'Chrome',
    # Sampling cadence. 100-200 ms is the range under test; the default sits in the middle.
    [ValidateRange(20, 5000)]
    [int]$IntervalMs = 150,
    # How long to sample. The brief asks for at least 15 s; the default runs longer on purpose so a
    # periodic re-anchor (if one exists) has time to show up at least once.
    [ValidateRange(1, 3600)]
    [int]$Seconds = 30,
    # Optional directory for the CSV/JSON artifacts. Defaults to the workspace so the analysis step
    # can read them without guessing a temp path.
    [string]$OutDir = ''
)

# test/manual/sample-smtc-timeline.ps1
#
# Samples one SMTC session's TimelineProperties on a tight interval and writes every observation to
# CSV, to answer a single question: can `Position` + `LastUpdatedTime` anchor a local monotonic clock
# that is accurate enough for word-by-word lyric sync?
#
# Read-only against the target player: it issues no Try* command. It deliberately does NOT poll
# GetSessions() in the sample loop - the session object is resolved once and reused, so the loop
# measures the timeline's own update behaviour rather than enumeration cost.
#
# Windows PowerShell 5.1 is required (not pwsh 7): only the Desktop edition projects the Windows
# Runtime media-control types. When launched from PowerShell 7 the script re-execs itself under 5.1,
# same as watch-smtc.ps1 and probe-smtc.ps1.

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

# Wall clock as epoch milliseconds. DateTimeOffset.ToUnixTimeMilliseconds exists on .NET 4.6+, and
# the epoch form keeps the CSV free of locale-dependent date formatting.
function Get-EpochMs {
    param([Parameter(Mandatory = $true)][datetimeoffset]$Value)
    return $Value.ToUnixTimeMilliseconds()
}

# Some players leave optional timeline fields unset (Media Player reports no Min/MaxSeekTime), and a
# projection that never got a value throws on `.TotalMilliseconds` instead of yielding null. Empty
# string is used rather than 0 so "absent" is distinguishable from "zero" in the CSV.
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
$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
$csvPath = Join-Path $OutDir ("smtc-timeline-$stamp.csv")
$jsonPath = Join-Path $OutDir ("smtc-timeline-$stamp.json")

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
$isCurrent = $targetSourceAppId -eq $currentSourceAppId
Write-Output ''
Write-Output ('=== sampling {0} ===' -f $targetSourceAppId)
Write-Output ('isCurrentSession = {0}' -f $isCurrent.ToString().ToLowerInvariant())
Write-Output ('interval = {0} ms, duration = {1} s, expected samples ~ {2}' -f $IntervalMs, $Seconds, [int](($Seconds * 1000) / $IntervalMs))

$rows = New-Object System.Collections.Generic.List[object]
$deadline = (Get-Date).AddSeconds($Seconds)
$index = 0

while ((Get-Date) -lt $deadline) {
    $loopStart = (Get-Date).ToUniversalTime()
    $playbackInfo = $target.GetPlaybackInfo()
    $timeline = $target.GetTimelineProperties()

    $rows.Add([pscustomobject]@{
        index              = $index
        frameEpochMs       = Get-EpochMs $loopStart
        playbackStatus     = [string]$playbackInfo.PlaybackStatus
        positionMs         = Get-OptionalTotalMs { $timeline.Position }
        startTimeMs        = Get-OptionalTotalMs { $timeline.StartTime }
        endTimeMs          = Get-OptionalTotalMs { $timeline.EndTime }
        minSeekTimeMs      = Get-OptionalTotalMs { $timeline.MinSeekTime }
        maxSeekTimeMs      = Get-OptionalTotalMs { $timeline.MaxSeekTime }
        lastUpdatedEpochMs = Get-EpochMs $timeline.LastUpdatedTime
    })

    $index++
    Start-Sleep -Milliseconds $IntervalMs
}

$rows | Export-Csv -Path $csvPath -NoTypeInformation -Encoding UTF8

# Summarises what the analysis step needs, so the raw CSV stays the single source of truth.
# Optional fields come back as '' and are dropped before measuring, so an absent field never reads
# as a zero-length position.
function Get-NumericValues {
    param([Parameter(Mandatory = $true)]$Rows, [Parameter(Mandatory = $true)][string]$Name)

    return @(
        $Rows |
            ForEach-Object { $_.$Name } |
            Where-Object { $_ -ne '' -and $null -ne $_ } |
            ForEach-Object { [double]$_ }
    )
}

$positions = Get-NumericValues -Rows $rows -Name 'positionMs'
$distinctPositions = @($positions | Select-Object -Unique)
$statuses = @($rows | ForEach-Object { $_.playbackStatus } | Select-Object -Unique)
$updated = @($rows | ForEach-Object { $_.lastUpdatedEpochMs } | Select-Object -Unique)
$positionMin = if ($positions.Count -gt 0) { ($positions | Measure-Object -Minimum).Minimum } else { $null }
$positionMax = if ($positions.Count -gt 0) { ($positions | Measure-Object -Maximum).Maximum } else { $null }

$summary = [pscustomobject]@{
    sourceAppUserModelId = $targetSourceAppId
    isCurrentSession     = $isCurrent
    sampledAt            = (Get-Date).ToString('o')
    intervalMs           = $IntervalMs
    requestedSeconds     = $Seconds
    sampleCount          = $rows.Count
    firstFrameEpochMs    = $rows[0].frameEpochMs
    lastFrameEpochMs     = $rows[$rows.Count - 1].frameEpochMs
    positionMinMs        = $positionMin
    positionMaxMs        = $positionMax
    distinctPositions    = $distinctPositions.Count
    distinctLastUpdated  = $updated.Count
    playbackStatuses     = ($statuses -join ',')
    csvPath              = $csvPath
}
$summary | ConvertTo-Json -Depth 5 | Set-Content -Path $jsonPath -Encoding UTF8

Write-Output ''
Write-Output '=== raw summary ==='
$summary | Format-List
Write-Output ('CSV  : {0}' -f $csvPath)
Write-Output ('JSON : {0}' -f $jsonPath)
