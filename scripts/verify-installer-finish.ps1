param([Parameter(Mandatory=$true)][string]$Installer, [Parameter(Mandatory=$true)][string]$Installation, [Parameter(Mandatory=$true)][string]$Receipt, [switch]$Attach)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') { throw 'This interactive installer check requires an isolated Windows release runner.' }
$reviewRoot = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\') + '\'
foreach ($reviewPath in @($Installer, $Installation, $Receipt)) {
    if (-not [IO.Path]::GetFullPath($reviewPath).StartsWith($reviewRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Installer review path is outside the runner temporary directory.' }
}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -Path (Join-Path $PSScriptRoot 'installer-controls.cs')

function Read-InstallerControls($Elements) {
    $page = @{launch=0; shortcut=0; finish=0; next=0; observed=@()}
    foreach ($element in $Elements) {
        $current = $element.Current
        $label = ([string]$current.Name).Replace('&', '').Trim()
        $handle = $current.NativeWindowHandle
        $nativeClass = if ($handle) { [InstallerControls]::ClassName($handle) } else { '' }
        $enabled = $current.IsEnabled
        $page.observed += @{label=$label; nativeClass=$nativeClass; enabled=$enabled}
        if ($nativeClass -ne 'Button' -or !$enabled) { continue }
        if ($label -eq 'Open OpenGEO') { $page.launch = $handle }
        if ($label -eq 'Create a desktop shortcut') { $page.shortcut = $handle }
        if ($label -eq 'Finish') { $page.finish = $handle }
        if ($label -in @('Next >', 'Next', 'Install')) { $page.next = $handle }
    }
    return $page
}

$process = $null
if ($Attach) {
    $attachDeadline = [DateTime]::UtcNow.AddSeconds(30)
    while (-not $process -and [DateTime]::UtcNow -lt $attachDeadline) {
        $matches = @(Get-Process | Where-Object { $_.Path -eq $Installer })
        if ($matches.Count -gt 1) { throw 'Ambiguous installer process.' }
        if ($matches.Count -eq 1) { $process = $matches[0] } else { Start-Sleep -Milliseconds 200 }
    }
    if (-not $process) { throw 'The updater did not start its verified installer.' }
} else { $process = [Diagnostics.Process]::Start($Installer, '/currentuser /D=' + $Installation) }
# Keep the attached process handle alive so its exit status remains available.
$null = $process.Handle
$deadline = [DateTime]::UtcNow.AddSeconds(180)
$finishVerified = $false
$observed = @()
try {
    while ([DateTime]::UtcNow -lt $deadline -and -not $process.HasExited) {
        try {
            $window = [Windows.Automation.AutomationElement]::RootElement.FindFirst([Windows.Automation.TreeScope]::Children, [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ProcessIdProperty, $process.Id))
            if ($null -eq $window) { Start-Sleep -Milliseconds 200; continue }
            $elements = $window.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)
            $page = Read-InstallerControls $elements
            $observed = $page.observed
        } catch {
            # NSIS destroys the outgoing page's controls when it opens the next one.
            $errorCause = $_.Exception.GetBaseException()
            if ($errorCause -isnot [Windows.Automation.ElementNotAvailableException] -and
                ($errorCause -isnot [ComponentModel.Win32Exception] -or $errorCause.NativeErrorCode -ne 1400)) {
                throw
            }
            Start-Sleep -Milliseconds 200
            continue
        }
        if ($page.finish -and $page.launch -and $page.shortcut) {
            $launchHandle = $page.launch
            $shortcutHandle = $page.shortcut
            if ([InstallerControls]::CheckState($launchHandle) -ne 0) { [InstallerControls]::Click($launchHandle) }
            if ([InstallerControls]::CheckState($shortcutHandle) -ne 1) { [InstallerControls]::Click($shortcutHandle) }
            $toggleDeadline = [DateTime]::UtcNow.AddSeconds(5)
            while (([InstallerControls]::CheckState($launchHandle) -ne 0 -or [InstallerControls]::CheckState($shortcutHandle) -ne 1) -and [DateTime]::UtcNow -lt $toggleDeadline) { Start-Sleep -Milliseconds 50 }
            if ([InstallerControls]::CheckState($launchHandle) -ne 0 -or [InstallerControls]::CheckState($shortcutHandle) -ne 1) { throw 'Finish checkboxes did not retain independent selections.' }
            [InstallerControls]::Click($page.finish)
            $finishVerified = $true
            break
        }
        if ($page.next) { [InstallerControls]::Click($page.next) }
        Start-Sleep -Milliseconds 200
    }
    if (-not $finishVerified -or -not $process.WaitForExit(30000) -or $process.ExitCode -ne 0) { throw 'The actual installer finish screen did not complete successfully.' }
    $desktopLink = Join-Path ([Environment]::GetFolderPath('Desktop')) 'OpenGEO.lnk'
    if (-not (Test-Path -LiteralPath $desktopLink)) { throw 'Selected desktop shortcut was not created.' }
    $shell = New-Object -ComObject WScript.Shell
    $target = $shell.CreateShortcut($desktopLink).TargetPath
    if ([IO.Path]::GetFullPath($target) -ne [IO.Path]::GetFullPath((Join-Path $Installation 'OpenGEO.exe'))) { throw 'Shortcut points to a different installation.' }
    @{finishScreen=$true; launchCheckbox=$true; shortcutCheckbox=$true; shortcutTargetVerified=$true; installerExit=$process.ExitCode} | ConvertTo-Json | Set-Content -LiteralPath $Receipt -Encoding utf8
} finally {
    # Preserve the actual stalled phase and owned process tree before cleanup.
    # Command lines and unrelated runner processes are deliberately not retained.
    $processEvidence = @(); $observationError = $null
    try {
        $allProcesses = @(Get-CimInstance Win32_Process -OperationTimeoutSec 5)
        $ownedIds = [Collections.Generic.HashSet[uint32]]::new()
        $null = $ownedIds.Add([uint32]$process.Id)
        $installationPrefix = [IO.Path]::GetFullPath($Installation).TrimEnd('\') + '\'
        foreach ($entry in $allProcesses) {
            if ($entry.ExecutablePath -and $entry.ExecutablePath.StartsWith($installationPrefix, [StringComparison]::OrdinalIgnoreCase)) { $null = $ownedIds.Add([uint32]$entry.ProcessId) }
        }
        do {
            $added = $false
            foreach ($entry in $allProcesses) {
                if ($ownedIds.Contains([uint32]$entry.ParentProcessId) -and $ownedIds.Add([uint32]$entry.ProcessId)) { $added = $true }
            }
        } while ($added)
        $processEvidence = @($allProcesses | Where-Object { $ownedIds.Contains([uint32]$_.ProcessId) } | Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CreationDate, KernelModeTime, UserModeTime, ReadTransferCount, WriteTransferCount, ThreadCount)
    } catch { $observationError = $_.Exception.Message }
    $installedFiles = @('OpenGEO.exe', 'Uninstall OpenGEO.exe', 'resources\app.asar') | ForEach-Object {
        $file = Get-Item -LiteralPath (Join-Path $Installation $_) -ErrorAction SilentlyContinue
        @{path=$_; exists=($null -ne $file); bytes=if ($file) {$file.Length} else {$null}; modified=if ($file) {$file.LastWriteTimeUtc} else {$null}}
    }
    @{finishObserved=$finishVerified; controls=$observed; processes=$processEvidence; installedFiles=$installedFiles; observationError=$observationError} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath ($Receipt + '.diagnostic.json') -Encoding utf8
    if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
}
