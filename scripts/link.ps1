#Requires -Version 5.1
<#
.SYNOPSIS
Link this checkout's mods and layouts into a Windows Herdr profile.
.DESCRIPTION
Stop Herdr before running this script. Mod directories use junctions. Layout
JSON files and SVG previews use symbolic links. Existing conflicts are not
changed. File symbolic links need an Administrator session in Windows
PowerShell 5.1, or Developer Mode with a supported PowerShell version.
.EXAMPLE
.\scripts\link.ps1 -WhatIf
.EXAMPLE
.\scripts\link.ps1
.EXAMPLE
.\scripts\link.ps1 -AppHome C:\Herdr-Test-Profile
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string] $AppHome = (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.config\herdr-app')
)

$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'This script requires Windows. Use scripts/link.sh on macOS or Linux.'
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$AppHome = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($AppHome)
$status = 0

function Test-LinkTarget {
    param($Item, [string] $Source)

    if ($Item.LinkType -notin @('Junction', 'SymbolicLink')) {
        return $false
    }
    $targets = @($Item.Target)
    if ($targets.Count -ne 1 -or [string]::IsNullOrEmpty($targets[0])) {
        return $false
    }
    $stored = $targets[0]
    if (-not [IO.Path]::IsPathRooted($stored)) {
        $stored = Join-Path (Split-Path -Parent $Item.FullName) $stored
    }
    return [string]::Equals(
        [IO.Path]::GetFullPath($stored).TrimEnd([char[]] '\/'),
        $Source.TrimEnd([char[]] '\/'),
        [StringComparison]::OrdinalIgnoreCase
    )
}

foreach ($kind in @('mods', 'layouts')) {
    $sourceDir = Join-Path $repoRoot $kind
    $targetDir = Join-Path $AppHome $kind
    try {
        if (-not (Test-Path -LiteralPath $targetDir -PathType Container)) {
            if ($PSCmdlet.ShouldProcess($targetDir, 'Create directory')) {
                New-Item -ItemType Directory -Path $targetDir | Out-Null
            }
        }
        if (-not (Test-Path -LiteralPath $sourceDir -PathType Container)) {
            continue
        }
        $sources = @(Get-ChildItem -LiteralPath $sourceDir | Where-Object {
            $_.Name -notlike '.*' -and (
                ($kind -eq 'mods' -and $_.PSIsContainer) -or
                ($kind -eq 'layouts' -and -not $_.PSIsContainer -and $_.Extension -in @('.json', '.svg'))
            )
        })
    }
    catch {
        Write-Warning ("Cannot process {0}: {1}" -f $kind, $_.Exception.Message)
        $status = 1
        continue
    }

    foreach ($source in $sources) {
        $target = Join-Path $targetDir $source.Name
        $linkType = if ($kind -eq 'mods') { 'Junction' } else { 'SymbolicLink' }
        try {
            $existing = Get-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue
            if ($null -ne $existing) {
                if (Test-LinkTarget $existing $source.FullName) {
                    Write-Host ("Already linked: {0}" -f $target)
                }
                else {
                    Write-Warning ("Conflict, not changed: {0}" -f $target)
                    $status = 1
                }
                continue
            }
            if ($PSCmdlet.ShouldProcess($target, "Create $linkType to $($source.FullName)")) {
                New-Item -ItemType $linkType -Path $target -Target $source.FullName | Out-Null
                Write-Host ("Linked: {0} -> {1}" -f $target, $source.FullName)
            }
        }
        catch {
            Write-Warning ("Cannot link {0}: {1}" -f $target, $_.Exception.Message)
            if ($linkType -eq 'SymbolicLink') {
                Write-Warning 'Use an Administrator session, or enable Windows Developer Mode with a supported PowerShell version. Windows PowerShell 5.1 may require Administrator permissions.'
            }
            $status = 1
        }
    }
}

exit $status
