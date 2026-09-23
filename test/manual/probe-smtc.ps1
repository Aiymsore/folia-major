param(
    # Substring match against SourceAppUserModelId. The default targets the Chrome tab playing
    # music.apple.com (the external-media backend's media source); `Chrome` matches any Chrome
    # channel AUMID spelling while excluding Edge and other players.
    [string]$Match = 'Chrome',
    [string[]]$Command = @('TogglePlayPause', 'SkipNext'),
    [switch]$DryRun,
    [switch]$Once,
    # Fails (exit 3) unless the matched target is NOT the current media session. The whole point of
    # the non-current experiment is that the session being driven is not the one the OS has focused;
    # without this guard a run where the target happened to be current would silently prove nothing.
    [switch]$RequireNonCurrent,
    [ValidateRange(100, 60000)]
    [int]$IntervalMs = 1000,
    [ValidateRange(0, 600000)]
    [int]$WaitSeconds = 0
)

# test/manual/probe-smtc.ps1
#
# Standalone Windows SMTC read + control verification. This script exists ONLY to answer one
# question against a real player (the Chrome tab playing music.apple.com): can a plain desktop process enumerate
# GlobalSystemMediaTransportControlsSession objects owned by OTHER applications, read their
# metadata/timeline, and drive them with TryTogglePlayPauseAsync / TrySkipNextAsync?
#
# It deliberately touches nothing in Folia: no Electron, no Folia playback code, no IPC. It is a
# manual probe, not part of the app, and nothing in src/ or electron/ imports it.
#
# Windows PowerShell 5.1 is required (not pwsh 7): only the Desktop edition projects the Windows
# Runtime media-control types through Add-Type -AssemblyName System.Runtime.WindowsRuntime. When
# launched from PowerShell 7 the script re-execs itself under 5.1, same as watch-smtc.ps1.

$ErrorActionPreference = 'Stop'

if ($PSVersionTable.PSEdition -ne 'Desktop') {
    $windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (-not (Test-Path -LiteralPath $windowsPowerShell)) {
        throw 'Windows PowerShell 5.1 was not found; it is required to access the SMTC WinRT API.'
    }

    $forwardedArguments = @(
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', $PSCommandPath,
        '-Match', $Match,
        '-IntervalMs', [string]$IntervalMs,
        '-WaitSeconds', [string]$WaitSeconds
    )
    foreach ($name in $Command) { $forwardedArguments += @('-Command', $name) }
    if ($DryRun) { $forwardedArguments += '-DryRun' }
    if ($Once) { $forwardedArguments += '-Once' }

    & $windowsPowerShell @forwardedArguments
    exit $LASTEXITCODE
}

Add-Type -AssemblyName System.Runtime.WindowsRuntime

$managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$mediaPropertiesType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]
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

# Both IAsyncOperation<T> and IAsyncOperationWithProgress<T,P> project onto this single-arg
# adapter, so one helper drives manager lookup, property fetch, and every Try*Async command.
function Wait-WinRtResult {
    param(
        [Parameter(Mandatory = $true)]$Operation,
        [Parameter(Mandatory = $true)][Type]$ResultType
    )

    $task = $script:asTaskMethod.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
    return $task.GetAwaiter().GetResult()
}

function Format-SmtcText {
    param([AllowNull()][object]$Value)

    if ($null -eq $Value) { return '""' }
    $text = [string]$Value
    if ([string]::IsNullOrWhiteSpace($text)) { return '""' }
    $singleLine = $text.Replace("`r", ' ').Replace("`n", ' ').Replace('"', '\"')
    return '"' + $singleLine + '"'
}

function Format-SmtcSeconds {
    param([AllowNull()][object]$Value)

    if ($null -eq $Value) { return '-' }
    return ([double]$Value.TotalSeconds).ToString('0.000', [Globalization.CultureInfo]::InvariantCulture)
}

# Prints the AUMID of every session verbatim. AUMID matching is the only reliable identity here:
# it is the string the OS itself uses, so it must never be normalized or truncated before it is
# shown, or a wrong guess about Apple Music's id would look like a confirmed one.
function Write-SessionInventory {
    param([Parameter(Mandatory = $true)]$Sessions, [AllowNull()][string]$CurrentSourceAppId)

    if (@($Sessions).Count -eq 0) {
        Write-Output '  <no sessions>'
        return
    }

    $index = 0
    foreach ($session in $Sessions) {
        $isCurrent = $session.SourceAppUserModelId -eq $CurrentSourceAppId
        Write-Output ('  [{0}] SourceAppUserModelId={1} current={2}' -f
            $index,
            (Format-SmtcText $session.SourceAppUserModelId),
            $isCurrent.ToString().ToLowerInvariant())
        $index++
    }
}

function Get-SessionSnapshot {
    param([Parameter(Mandatory = $true)]$Session)

    $playbackInfo = $Session.GetPlaybackInfo()
    $timeline = $Session.GetTimelineProperties()
    $properties = Wait-WinRtResult -Operation $Session.TryGetMediaPropertiesAsync() -ResultType $script:mediaPropertiesType

    return [pscustomobject]@{
        SourceAppId = [string]$Session.SourceAppUserModelId
        PlaybackStatus = [string]$playbackInfo.PlaybackStatus
        IsPlaying = $null -ne $playbackInfo.Controls -and $playbackInfo.Controls.IsPlayEnabled
        Title = [string]$properties.Title
        Artist = [string]$properties.Artist
        Album = [string]$properties.AlbumTitle
        TrackNumber = [uint32]$properties.TrackNumber
        HasThumbnail = $null -ne $properties.Thumbnail
        Position = $timeline.Position
        StartTime = $timeline.StartTime
        EndTime = $timeline.EndTime
        LastUpdatedTime = $timeline.LastUpdatedTime
    }
}

function Write-SessionSnapshot {
    param([Parameter(Mandatory = $true)]$Snapshot)

    Write-Output '  --- read ---'
    Write-Output ('  SourceAppUserModelId : {0}' -f (Format-SmtcText $Snapshot.SourceAppId))
    Write-Output ('  PlaybackStatus       : {0}' -f $Snapshot.PlaybackStatus)
    Write-Output ('  Title                : {0}' -f (Format-SmtcText $Snapshot.Title))
    Write-Output ('  Artist               : {0}' -f (Format-SmtcText $Snapshot.Artist))
    Write-Output ('  Album                : {0}' -f (Format-SmtcText $Snapshot.Album))
    Write-Output ('  TrackNumber          : {0}' -f $Snapshot.TrackNumber)
    Write-Output ('  HasThumbnail         : {0}' -f $Snapshot.HasThumbnail.ToString().ToLowerInvariant())
    Write-Output ('  Position / EndTime   : {0} / {1}' -f
        (Format-SmtcSeconds $Snapshot.Position), (Format-SmtcSeconds $Snapshot.EndTime))
    $updated = if ($Snapshot.LastUpdatedTime) {
        $Snapshot.LastUpdatedTime.ToLocalTime().ToString('HH:mm:ss.fff')
    } else { '-' }
    Write-Output ('  TimelineUpdated      : {0}' -f $updated)
}

# Runs one Try*Async and reports the bool the OS returned. A `false` is a real answer, not an
# error: it means the session refused the command (not current, controls disabled, app busy).
#
# RETURN CONTRACT: this function returns ONLY the bool. Its human-readable line is emitted as a
# separate pipeline object, so callers must NOT wrap the call in `[void](...)`.
# Windows PowerShell 5.1 discards a called function's inner pipeline output along with the
# `[void]` cast, which is exactly how an earlier revision of this probe ran TryTogglePlayPause
# successfully while printing nothing at all.
function Invoke-SmtcCommand {
    param(
        [Parameter(Mandatory = $true)]$Session,
        [Parameter(Mandatory = $true)][string]$Name
    )

    switch ($Name) {
        'TogglePlayPause' { $result = Wait-WinRtResult -Operation $Session.TryTogglePlayPauseAsync() -ResultType ([bool]); $label = 'TryTogglePlayPauseAsync()' }
        'Play'            { $result = Wait-WinRtResult -Operation $Session.TryPlayAsync() -ResultType ([bool]);            $label = 'TryPlayAsync()' }
        'Pause'           { $result = Wait-WinRtResult -Operation $Session.TryPauseAsync() -ResultType ([bool]);           $label = 'TryPauseAsync()' }
        'SkipNext'        { $result = Wait-WinRtResult -Operation $Session.TrySkipNextAsync() -ResultType ([bool]);        $label = 'TrySkipNextAsync()' }
        'SkipPrevious'    { $result = Wait-WinRtResult -Operation $Session.TrySkipPreviousAsync() -ResultType ([bool]);    $label = 'TrySkipPreviousAsync()' }
        'Stop'            { $result = Wait-WinRtResult -Operation $Session.TryStopAsync() -ResultType ([bool]);            $label = 'TryStopAsync()' }
        default {
            throw "Unknown command '$Name'. Use TogglePlayPause|Play|Pause|SkipNext|SkipPrevious|Stop."
        }
    }

    # Separate objects: the audit line goes to the information stream so it always displays without
    # joining the pipeline, then the bare bool is this function's single return value. Direct callers
    # should capture the value (`$r = Invoke-SmtcCommand ...`); an uncaptured call prints only the
    # audit line, never the formatted one, which is why earlier revisions looked empty.
    Write-Information -MessageData ('  {0,-35}-> {1}' -f $label, $result) -InformationAction Continue
    Write-Output $result
}

function Get-SmtcManager {
    try {
        return Wait-WinRtResult -Operation $managerType::RequestAsync() -ResultType $managerType
    } catch {
        $detail = $_.Exception.InnerException.Message
        if ([string]::IsNullOrWhiteSpace($detail)) { $detail = $_.Exception.Message }
        throw "Could not connect to the Windows SMTC session manager: $detail"
    }
}

# Asks the MANAGER (not the session) to make a session the active media player. Try* commands
# already succeed on the current session without this, so it is optional and its absence is
# reported rather than treated as a failure. Kept because the hand-off is what makes a
# non-current session eligible for Try* commands, which is the case this probe must not assume
# away when a future Windows build starts refusing commands on a non-current session.
function Request-SmtcControl {
    param(
        [Parameter(Mandatory = $true)]$Manager,
        [Parameter(Mandatory = $true)]$Session
    )

    if ($null -eq $script:setActiveMediaPlayerMethod) {
        # Optional hand-off: absence is reported, never treated as a refusal.
        Write-Information -MessageData ('  {0,-35}-> unavailable on this Windows build (optional)' -f 'TrySetActiveMediaPlayerAsync()') -InformationAction Continue
        return $false
    }

    try {
        $operation = $script:setActiveMediaPlayerMethod.Invoke($Manager, @($Session))
        $result = Wait-WinRtResult -Operation $operation -ResultType ([bool])
        Write-Information -MessageData ('  {0,-35}-> {1}' -f 'TrySetActiveMediaPlayerAsync()', $result) -InformationAction Continue
        return $result
    } catch {
        Write-Information -MessageData ('  {0,-35}-> threw: {1}' -f 'TrySetActiveMediaPlayerAsync()', $_.Exception.Message) -InformationAction Continue
        return $false
    }
}

# TrySetActiveMediaPlayerAsync lives on the manager, not on a session, and is newer than the rest
# of the surface, so it is probed by reflection instead of called directly: a direct call against
# a build without it fails at invocation time, which is indistinguishable from a real refusal.
$setActiveMediaPlayerMethod = $managerType.GetMethod(
    'TrySetActiveMediaPlayerAsync',
    [System.Reflection.BindingFlags]::Public -bor [System.Reflection.BindingFlags]::Instance
)

$deadline = (Get-Date).AddSeconds($WaitSeconds)
$attempt = 0

do {
    $attempt++
    $manager = Get-SmtcManager
    $sessions = @($manager.GetSessions())
    $current = $manager.GetCurrentSession()
    $currentSourceAppId = if ($current) { [string]$current.SourceAppUserModelId } else { $null }

    $timestamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss.fff')
    Write-Output ''
    Write-Output ('=== attempt {0} @ {1} ===' -f $attempt, $timestamp)
    Write-Output ('CurrentSession.SourceAppUserModelId = {0}' -f (Format-SmtcText $currentSourceAppId))
    Write-Output ('Session count = {0}' -f $sessions.Count)
    Write-Output 'All sessions:'
    Write-SessionInventory -Sessions $sessions -CurrentSourceAppId $currentSourceAppId

    $targets = @($sessions | Where-Object { $_.SourceAppUserModelId -like ('*' + $Match + '*') })

    # States the current-ness of every session up front, so a control result can never be misread
    # as "the target was current, of course it worked".
    Write-Output 'Session status:'
    foreach ($session in $sessions) {
        $status = try { [string]$session.GetPlaybackInfo().PlaybackStatus } catch { 'unreadable' }
        Write-Output ('  {0,-52} current={1,-5} status={2}' -f
            (Format-SmtcText $session.SourceAppUserModelId),
            ($session.SourceAppUserModelId -eq $currentSourceAppId).ToString().ToLowerInvariant(),
            $status)
    }

    if ($targets.Count -eq 0) {
        Write-Output ('No session matched -Match ''{0}'' yet.' -f $Match)
        if ($WaitSeconds -gt 0 -and (Get-Date) -lt $deadline) {
            Start-Sleep -Milliseconds $IntervalMs
            continue
        }
        Write-Output 'Nothing to control. Start playback in the matched player and re-run.'
        exit 2
    }

    if ($RequireNonCurrent) {
        $targets = @($targets | Where-Object { $_.SourceAppUserModelId -ne $currentSourceAppId })
        if ($targets.Count -eq 0) {
            Write-Output ('-RequireNonCurrent was set but every match is the current session. Aborting: a command accepted here would prove nothing about non-current control.')
            exit 3
        }
    }

    foreach ($target in $targets) {
        $targetIsCurrent = $target.SourceAppUserModelId -eq $currentSourceAppId
        Write-Output ''
        Write-Output ('--- target SourceAppUserModelId={0} ---' -f (Format-SmtcText $target.SourceAppUserModelId))
        Write-Output ('  target is CurrentSession : {0}' -f $targetIsCurrent.ToString().ToLowerInvariant())

        $snapshot = Get-SessionSnapshot -Session $target
        $statusBefore = $snapshot.PlaybackStatus
        $titleBefore = $snapshot.Title
        Write-SessionSnapshot -Snapshot $snapshot

        if ($DryRun) {
            Write-Output '  (dry run: no Try* command sent)'
            continue
        }

        Write-Output '  --- control ---'
        # Each call returns exactly one bool; the audit lines come from the information stream.
        $summary = New-Object System.Collections.Generic.List[string]

        $setActive = Request-SmtcControl -Manager $manager -Session $target
        $summary.Add(('TrySetActiveMediaPlayerAsync={0}' -f $setActive))

        $commandIndex = 0
        foreach ($name in $Command) {
            $accepted = Invoke-SmtcCommand -Session $target -Name $name
            $commandIndex++
            $summary.Add(('{0}[{1}]={2}' -f $name, $commandIndex, $accepted))
            Start-Sleep -Milliseconds 700
        }

        Write-Output ('  --- command return values ---')
        Write-Output ('  {0}' -f ($summary -join '  '))

        # Re-read after the commands so the caller can tell "returned true" apart from "actually
        # changed": a true with an unchanged status still proves the OS accepted the request.
        Start-Sleep -Milliseconds 800
        $after = Get-SessionSnapshot -Session $target
        Write-Output '  --- read after ---'
        Write-Output ('  PlaybackStatus       : {0}' -f $after.PlaybackStatus)
        Write-Output ('  Title                : {0}' -f (Format-SmtcText $after.Title))
        Write-Output ('  Position / EndTime   : {0} / {1}' -f
            (Format-SmtcSeconds $after.Position), (Format-SmtcSeconds $after.EndTime))

        $statusChanged = $after.PlaybackStatus -ne $statusBefore
        $titleChanged = $after.Title -ne $titleBefore
        Write-Output '  --- effect on the target ---'
        Write-Output ('  PlaybackStatus changed   : {0} ({1} -> {2})' -f $statusChanged.ToString().ToLowerInvariant(), $statusBefore, $after.PlaybackStatus)
        Write-Output ('  Title changed            : {0} ({1} -> {2})' -f
            $titleChanged.ToString().ToLowerInvariant(), (Format-SmtcText $titleBefore), (Format-SmtcText $after.Title))
    }

    if ($Once) { break }
    if ($WaitSeconds -gt 0 -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds $IntervalMs
        continue
    }
    break
} while ($true)
