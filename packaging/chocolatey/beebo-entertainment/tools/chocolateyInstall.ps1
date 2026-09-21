$ErrorActionPreference = 'Stop'

# Installs Beebo Entertainment from the vendor's GitHub release. The installer is an
# electron-builder / NSIS one-click, per-machine setup: /S is its silent switch.
$packageArgs = @{
  packageName    = $env:ChocolateyPackageName
  fileType       = 'exe'
  url64bit       = 'https://github.com/SWGfan/beebotv/releases/download/Beebo-0.1.57/BeeboEntertainmentSetup.exe'
  checksum64     = '51f6a295a172eed3eedc6f43e25590ff6ebfe3fcbc5461bd247732315918d596'
  checksumType64 = 'sha256'
  silentArgs     = '/S'
  validExitCodes = @(0)
  softwareName   = 'Beebo Entertainment*'
}

Install-ChocolateyPackage @packageArgs
