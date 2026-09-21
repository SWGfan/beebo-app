<#
  Creates a self-signed TEST certificate for signing a sideload build of Beebo for Xbox.
  Nothing here is a secret of the project: the certificate is made on YOUR machine, is only good for
  Developer Mode testing, and must never be committed (dev-cert/ and *.pfx are git-ignored).

  Usage (PowerShell, from apps/xbox):
      ./tools/make-test-cert.ps1
  Then build with these MSBuild properties (README.md, "Build the package"):
      /p:AppxPackageSigningEnabled=true /p:PackageCertificateKeyFile=dev-cert\BeeboXboxTest.pfx
      /p:PackageCertificatePassword=<the password printed below> /p:PackageCertificateThumbprint=<thumbprint printed below>

  The certificate Subject must equal the Publisher in shell/Package.appxmanifest, so it is read from there
  unless -Subject is given. Method: Microsoft Learn, "Create a certificate for package signing".
#>
param(
    [string]$Subject,
    [string]$OutDir = (Join-Path $PSScriptRoot '..\dev-cert'),
    [string]$Password
)
$ErrorActionPreference = 'Stop'

if (-not $Subject) {
    $manifest = Get-Content (Join-Path $PSScriptRoot '..\shell\Package.appxmanifest') -Raw
    $Subject = [regex]::Match($manifest, '<Identity[^>]*Publisher="([^"]+)"').Groups[1].Value
}
if (-not $Subject -or $Subject -notmatch '^CN=') { throw "Publisher/Subject must look like CN=... (got '$Subject')" }

if (-not $Password) {
    $bytes = New-Object byte[] 18
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $Password = [Convert]::ToBase64String($bytes).Replace('+', 'a').Replace('/', 'b').Replace('=', 'c')
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$cert = New-SelfSignedCertificate -Type Custom -Subject $Subject -KeyUsage DigitalSignature `
    -FriendlyName 'Beebo Xbox test signing' -CertStoreLocation 'Cert:\CurrentUser\My' `
    -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}')

$secure = ConvertTo-SecureString -String $Password -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath (Join-Path $OutDir 'BeeboXboxTest.pfx') -Password $secure | Out-Null
Export-Certificate -Cert $cert -FilePath (Join-Path $OutDir 'BeeboXboxTest.cer') | Out-Null
Set-Content -Path (Join-Path $OutDir 'thumbprint.txt') -Value $cert.Thumbprint -Encoding ascii
Set-Content -Path (Join-Path $OutDir 'password.txt') -Value $Password -Encoding ascii

Write-Host "Subject:     $Subject"
Write-Host "Thumbprint:  $($cert.Thumbprint)"
Write-Host "Files:       $OutDir  (BeeboXboxTest.pfx, BeeboXboxTest.cer, thumbprint.txt, password.txt)"
Write-Host 'Keep this folder private. It is git-ignored.'
