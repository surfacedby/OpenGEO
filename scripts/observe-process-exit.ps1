param([Parameter(Mandatory=$true)][int]$ObservedProcessId, [Parameter(Mandatory=$true)][string]$Executable)
$ErrorActionPreference = 'Stop'
$observedProcess = [Diagnostics.Process]::GetProcessById($ObservedProcessId)
try {
    # Retain the OS handle before shutdown so PID reuse cannot satisfy the observation.
    $null = $observedProcess.Handle
    if (-not [StringComparer]::OrdinalIgnoreCase.Equals([IO.Path]::GetFullPath($observedProcess.MainModule.FileName), [IO.Path]::GetFullPath($Executable))) {
        throw 'The observed process is not the expected application.'
    }
    @{state='watching'; processId=$ObservedProcessId} | ConvertTo-Json -Compress
    if (-not $observedProcess.WaitForExit(30000)) { throw 'The application did not exit within 30 seconds.' }
    @{state='exited'; processId=$ObservedProcessId; exitCode=$observedProcess.ExitCode} | ConvertTo-Json -Compress
} finally { $observedProcess.Dispose() }
