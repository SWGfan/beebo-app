$ErrorActionPreference = 'Stop'

# The installer registers itself under HKLM\...\Uninstall\215db651-0b3f-50a9-a537-866a7c562233
# with DisplayName "Beebo Entertainment <version>" and
#   UninstallString = "C:\Program Files\Beebo Entertainment\Uninstall Beebo Entertainment.exe" /allusers
$keys = @(Get-UninstallRegistryKey -SoftwareName 'Beebo Entertainment*')

if ($keys.Count -eq 1) {
  $key = $keys[0]
  # Take the quoted path from UninstallString; the arguments are supplied below.
  $uninstaller = ($key.UninstallString -replace '^\s*"([^"]+)".*$', '$1')
  Uninstall-ChocolateyPackage -PackageName $env:ChocolateyPackageName `
    -FileType 'exe' `
    -SilentArgs '/allusers /S' `
    -File $uninstaller `
    -ValidExitCodes @(0)
} elseif ($keys.Count -eq 0) {
  Write-Warning "$env:ChocolateyPackageName has already been uninstalled by other means."
} else {
  Write-Warning "$($keys.Count) matches found, not uninstalling anything automatically."
  $keys | ForEach-Object { Write-Warning "- $($_.DisplayName)" }
}
