param(
  [string]$OutputDirectory = "./work/tmp/lan-tls",
  [string]$DnsName = "fast-translation.local",
  [string[]]$IpAddress = @(),
  [ValidateRange(1, 365)]
  [int]$ValidDays = 30
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
function Get-ExistingAncestor {
  param([Parameter(Mandatory)][string]$Path)
  $candidate = [System.IO.Path]::GetFullPath($Path)
  while ($true) {
    if ([System.IO.File]::Exists($candidate) -or [System.IO.Directory]::Exists($candidate)) {
      return $candidate
    }
    $parent = [System.IO.Directory]::GetParent($candidate)
    if ($null -eq $parent) {
      throw "Unable to resolve an existing ancestor for $Path."
    }
    $candidate = $parent.FullName
  }
}

function Assert-NoReparseAncestor {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$Label
  )
  $cursor = Get-ExistingAncestor -Path $Path
  while ($null -ne $cursor) {
    $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "$Label must not traverse a symlink or junction: $cursor"
    }
    $parent = [System.IO.Directory]::GetParent($cursor)
    if ($null -eq $parent -or $parent.FullName -eq $cursor) {
      break
    }
    $cursor = $parent.FullName
  }
}

$workspaceRoot = [System.IO.Path]::GetFullPath((Get-Location).Path)
$outputPath = [System.IO.Path]::GetFullPath(
  [System.IO.Path]::Combine($workspaceRoot, $OutputDirectory)
)
$workspacePrefix = $workspaceRoot.TrimEnd(
  [System.IO.Path]::DirectorySeparatorChar,
  [System.IO.Path]::AltDirectorySeparatorChar
) + [System.IO.Path]::DirectorySeparatorChar
if ($outputPath -ne $workspaceRoot -and -not $outputPath.StartsWith(
  $workspacePrefix,
  [System.StringComparison]::OrdinalIgnoreCase
)) {
  throw "OutputDirectory must stay inside the active workspace."
}
Assert-NoReparseAncestor -Path $outputPath -Label "OutputDirectory"
if ([string]::IsNullOrWhiteSpace($DnsName)) {
  throw "DnsName must not be empty."
}

function Convert-ToPem {
  param(
    [Parameter(Mandatory)]
    [string]$Label,
    [Parameter(Mandatory)]
    [byte[]]$Bytes
  )
  $base64 = [Convert]::ToBase64String($Bytes)
  $lines = for ($index = 0; $index -lt $base64.Length; $index += 64) {
    $length = [Math]::Min(64, $base64.Length - $index)
    $base64.Substring($index, $length)
  }
  return "-----BEGIN $Label-----`n$($lines -join "`n")`n-----END $Label-----`n"
}

$notBefore = [DateTimeOffset]::UtcNow.AddMinutes(-5)
$notAfter = $notBefore.AddDays($ValidDays)

$rootKey = [System.Security.Cryptography.RSA]::Create(4096)
$leafKey = [System.Security.Cryptography.RSA]::Create(2048)
$rootCertificate = $null
$issuedLeaf = $null
$leafCertificate = $null
try {
  $hashAlgorithm = [System.Security.Cryptography.HashAlgorithmName]::SHA256
  $signaturePadding = [System.Security.Cryptography.RSASignaturePadding]::Pkcs1

  $rootRequest = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
    "CN=Fast Translation Local Demo CA",
    $rootKey,
    $hashAlgorithm,
    $signaturePadding
  )
  $rootRequest.CertificateExtensions.Add(
    [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new(
      $true,
      $false,
      0,
      $true
    )
  )
  $rootUsage = [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign -bor
    [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::CrlSign
  $rootRequest.CertificateExtensions.Add(
    [System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
      $rootUsage,
      $true
    )
  )
  $rootRequest.CertificateExtensions.Add(
    [System.Security.Cryptography.X509Certificates.X509SubjectKeyIdentifierExtension]::new(
      $rootRequest.PublicKey,
      $false
    )
  )
  $rootCertificate = $rootRequest.CreateSelfSigned($notBefore, $notAfter)

  $leafRequest = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
    "CN=$DnsName",
    $leafKey,
    $hashAlgorithm,
    $signaturePadding
  )
  $leafRequest.CertificateExtensions.Add(
    [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new(
      $false,
      $false,
      0,
      $true
    )
  )
  $leafUsage = [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor
    [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment
  $leafRequest.CertificateExtensions.Add(
    [System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
      $leafUsage,
      $true
    )
  )
  $serverAuthentication = [System.Security.Cryptography.OidCollection]::new()
  [void]$serverAuthentication.Add(
    [System.Security.Cryptography.Oid]::new("1.3.6.1.5.5.7.3.1")
  )
  $leafRequest.CertificateExtensions.Add(
    [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new(
      $serverAuthentication,
      $false
    )
  )

  $san = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
  $san.AddDnsName($DnsName)
  if ($DnsName -ne "localhost") {
    $san.AddDnsName("localhost")
  }
  $san.AddIpAddress([System.Net.IPAddress]::Loopback)
  $san.AddIpAddress([System.Net.IPAddress]::IPv6Loopback)
  foreach ($address in $IpAddress) {
    $parsedAddress = [System.Net.IPAddress]::Parse($address)
    $san.AddIpAddress($parsedAddress)
  }
  $leafRequest.CertificateExtensions.Add($san.Build())
  $leafRequest.CertificateExtensions.Add(
    [System.Security.Cryptography.X509Certificates.X509SubjectKeyIdentifierExtension]::new(
      $leafRequest.PublicKey,
      $false
    )
  )

  $serial = [byte[]]::new(16)
  $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $random.GetBytes($serial)
  $random.Dispose()
  $serial[0] = $serial[0] -band 0x7f
  $issuedLeaf = $leafRequest.Create($rootCertificate, $notBefore, $notAfter, $serial)
  $leafCertificate = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::CopyWithPrivateKey(
    $issuedLeaf,
    $leafKey
  )

  [System.IO.Directory]::CreateDirectory($outputPath) | Out-Null
  $rootDer = $rootCertificate.Export(
    [System.Security.Cryptography.X509Certificates.X509ContentType]::Cert
  )
  $leafDer = $leafCertificate.Export(
    [System.Security.Cryptography.X509Certificates.X509ContentType]::Cert
  )
  $rootPem = Convert-ToPem -Label "CERTIFICATE" -Bytes $rootDer
  $leafPem = Convert-ToPem -Label "CERTIFICATE" -Bytes $leafDer
  if ($leafKey -is [System.Security.Cryptography.RSACng]) {
    $privateKeyBytes = $leafKey.Key.Export(
      [System.Security.Cryptography.CngKeyBlobFormat]::Pkcs8PrivateBlob
    )
  } else {
    $privateKeyBytes = $leafKey.ExportPkcs8PrivateKey()
  }
  $keyPem = Convert-ToPem -Label "PRIVATE KEY" -Bytes $privateKeyBytes

  [System.IO.File]::WriteAllText(
    [System.IO.Path]::Combine($outputPath, "server-cert.pem"),
    $leafPem + $rootPem,
    [System.Text.UTF8Encoding]::new($false)
  )
  [System.IO.File]::WriteAllText(
    [System.IO.Path]::Combine($outputPath, "server-key.pem"),
    $keyPem,
    [System.Text.UTF8Encoding]::new($false)
  )
  [System.IO.File]::WriteAllText(
    [System.IO.Path]::Combine($outputPath, "local-demo-ca.pem"),
    $rootPem,
    [System.Text.UTF8Encoding]::new($false)
  )
  [System.IO.File]::WriteAllBytes(
    [System.IO.Path]::Combine($outputPath, "local-demo-ca.cer"),
    $rootDer
  )

  $metadata = [ordered]@{
    dnsName = $DnsName
    ipAddresses = @($IpAddress)
    validFromUtc = $notBefore.ToString("O")
    validUntilUtc = $notAfter.ToString("O")
    certificatePath = "server-cert.pem"
    privateKeyPath = "server-key.pem"
    trustAnchorPath = "local-demo-ca.cer"
  }
  [System.IO.File]::WriteAllText(
    [System.IO.Path]::Combine($outputPath, "metadata.json"),
    ($metadata | ConvertTo-Json -Depth 3) + "`n",
    [System.Text.UTF8Encoding]::new($false)
  )

  Write-Output "Created LAN TLS assets in $outputPath"
  Write-Output "Install local-demo-ca.cer as a trusted root on each test phone."
  Write-Output "Set TLS_CERT_PATH to server-cert.pem and TLS_KEY_PATH to server-key.pem."
} finally {
  if ($null -ne $leafCertificate) {
    $leafCertificate.Dispose()
  }
  if ($null -ne $issuedLeaf) {
    $issuedLeaf.Dispose()
  }
  if ($null -ne $rootCertificate) {
    $rootCertificate.Dispose()
  }
  $leafKey.Dispose()
  $rootKey.Dispose()
}
