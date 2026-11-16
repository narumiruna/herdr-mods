#Requires -Version 5.1
<#
.SYNOPSIS
Remove this checkout's mod and layout links from a Windows Herdr profile.
.DESCRIPTION
Select a layout that is not supplied by this checkout, then stop Herdr before
running this script. Only same-name junctions and symbolic links that point to
this checkout are removed, including broken links. Source files, real files
and directories, and links to other locations are not changed.
.EXAMPLE
.\scripts\unlink.ps1 -WhatIf
.EXAMPLE
.\scripts\unlink.ps1
.EXAMPLE
.\scripts\unlink.ps1 -AppHome C:\Herdr-Test-Profile
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string] $AppHome = (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.config\herdr-app')
)

$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'This script requires Windows. Use scripts/unlink.sh on macOS or Linux.'
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
            continue
        }
        $targets = @(Get-ChildItem -LiteralPath $targetDir -Force | Where-Object {
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

    foreach ($target in $targets) {
        try {
            $source = Join-Path $sourceDir $target.Name
            if (-not (Test-LinkTarget $target $source)) {
                continue
            }
            if ($PSCmdlet.ShouldProcess($target.FullName, 'Remove link')) {
                # Delete only the link. Do not recurse into junction targets in Windows PowerShell 5.1.
                if ($target.PSIsContainer) {
                    [IO.Directory]::Delete($target.FullName)
                }
                else {
                    [IO.File]::Delete($target.FullName)
                }
                Write-Host ("Unlinked: {0}" -f $target.FullName)
            }
        }
        catch {
            Write-Warning ("Cannot unlink {0}: {1}" -f $target.FullName, $_.Exception.Message)
            $status = 1
        }
    }
}

exit $status
