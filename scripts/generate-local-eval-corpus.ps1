param(
  [string]$InputCsv = "./examples/manufacturing-glossary.csv",
  [string]$OutputDirectory = "./work/tmp/local-eval-corpus",
  [string]$VoiceName = "",
  [string]$Language = "en-US",
  [ValidateRange(-10, 10)]
  [int]$Rate = 0
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

$inputPath = [System.IO.Path]::GetFullPath(
  [System.IO.Path]::Combine($workspaceRoot, $InputCsv)
)
if (-not [System.IO.File]::Exists($inputPath)) {
  throw "Input glossary does not exist: $inputPath"
}
Assert-NoReparseAncestor -Path $inputPath -Label "InputCsv"
Assert-NoReparseAncestor -Path $outputPath -Label "OutputDirectory"

$rows = @(Import-Csv -LiteralPath $inputPath)
if ($rows.Count -eq 0) {
  throw "Input glossary must contain at least one row."
}
$requiredColumns = @("id", "source", "target_exact")
$availableColumns = @($rows[0].PSObject.Properties.Name)
foreach ($column in $requiredColumns) {
  if ($availableColumns -notcontains $column) {
    throw "Input glossary is missing required column $column."
  }
}

function Get-Aliases {
  param([AllowEmptyString()][string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) {
    return @()
  }
  $trimmed = $Value.Trim()
  if ($trimmed.StartsWith("[")) {
    $parsed = @($trimmed | ConvertFrom-Json)
    return @($parsed | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  }
  return @($trimmed -split "[|;`n]" | ForEach-Object { $_.Trim() } | Where-Object { $_.Length -gt 0 })
}

function Get-StableFileName {
  param(
    [string]$EntryId,
    [string]$Kind,
    [string]$Phrase
  )
  $safeId = ($EntryId -replace "[^A-Za-z0-9._-]+", "-").Trim("-")
  if ($safeId.Length -eq 0) {
    $safeId = "term"
  }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $digest = $sha.ComputeHash(
      [System.Text.Encoding]::UTF8.GetBytes("$EntryId`0$Kind`0$Phrase")
    )
  } finally {
    $sha.Dispose()
  }
  $suffix = ([Convert]::ToBase64String($digest)).Replace("+", "-").Replace("/", "_").TrimEnd("=").Substring(0, 12)
  return "$safeId-$Kind-$suffix.wav"
}

[System.IO.Directory]::CreateDirectory($outputPath) | Out-Null
$voice = $null
$selectedVoiceDescription = ""
$ffmpegCommand = Get-Command ffmpeg -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
try {
  try {
    $voice = New-Object -ComObject SAPI.SpVoice
    $tokens = @($voice.GetVoices())
    if ($tokens.Count -gt 0) {
      $culture = [System.Globalization.CultureInfo]::GetCultureInfo($Language)
      $languageAttribute = $culture.LCID.ToString("X")
      $selectedToken = $null
      for ($index = 0; $index -lt $tokens.Count; $index += 1) {
        $token = $tokens.Item($index)
        $description = $token.GetDescription()
        $matchesRequestedVoice =
          -not [string]::IsNullOrWhiteSpace($VoiceName) -and $description -like "*$VoiceName*"
        $matchesLanguage =
          [string]::IsNullOrWhiteSpace($VoiceName) -and
          @($token.GetAttribute("Language") -split ";") -contains $languageAttribute
        if ($matchesRequestedVoice -or $matchesLanguage) {
          $selectedToken = $token
          break
        }
      }
      if ($null -eq $selectedToken) {
        $selectedToken = $tokens.Item(0)
      }
      $voice.Voice = $selectedToken
      $voice.Rate = $Rate
      $selectedVoiceDescription = $selectedToken.GetDescription()
    } else {
      [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($voice)
      $voice = $null
    }
  } catch {
    if ($null -ne $voice) {
      try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($voice) } catch {}
      $voice = $null
    }
  }
  if ($null -eq $voice -and $null -eq $ffmpegCommand) {
    throw "Windows SAPI could not provide a voice and FFmpeg with the flite filter is not installed."
  }
  $fixtures = [System.Collections.Generic.List[object]]::new()
  $usedSapi = $false
  $usedFfmpegFallback = $false
  foreach ($row in $rows) {
    $entryId = [string]$row.id
    $source = [string]$row.source
    $targetExact = [string]$row.target_exact
    if (
      [string]::IsNullOrWhiteSpace($entryId) -or
      [string]::IsNullOrWhiteSpace($source) -or
      [string]::IsNullOrWhiteSpace($targetExact)
    ) {
      throw "Every glossary row must contain id, source, and target_exact."
    }

    $phrases = [System.Collections.Generic.List[object]]::new()
    $phrases.Add([ordered]@{ kind = "source"; phrase = $source.Trim() })
    foreach ($alias in (Get-Aliases -Value ([string]$row.aliases))) {
      $phrases.Add([ordered]@{ kind = "alias"; phrase = $alias })
    }

    $seen = [System.Collections.Generic.HashSet[string]]::new(
      [System.StringComparer]::OrdinalIgnoreCase
    )
    foreach ($candidate in $phrases) {
      if (-not $seen.Add($candidate.phrase)) {
        continue
      }
      $fileName = Get-StableFileName -EntryId $entryId -Kind $candidate.kind -Phrase $candidate.phrase
      $wavePath = [System.IO.Path]::Combine($outputPath, $fileName)
      $stream = $null
      $speakError = $null
      if ($null -ne $voice) {
        try {
          try {
            $stream = New-Object -ComObject SAPI.SpFileStream
            $stream.Format.Type = 26
            $stream.Open($wavePath, 3, $false)
            $voice.AudioOutputStream = $stream
            [void]$voice.Speak($candidate.phrase)
          } catch {
            $speakError = $_.Exception
          }
        } finally {
          if ($null -ne $stream) {
            try { $stream.Close() } catch {}
            [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($stream)
          }
        }
      }
      $waveLength = if ([System.IO.File]::Exists($wavePath)) {
        ([System.IO.FileInfo]::new($wavePath)).Length
      } else {
        0
      }
      if ($null -eq $voice -or $null -ne $speakError -or $waveLength -le 44) {
        if ($null -eq $ffmpegCommand) {
          $failureReason = if ($null -ne $speakError) {
            $speakError.Message
          } elseif ($null -eq $voice) {
            "Windows SAPI could not provide a voice"
          } else {
            "Windows SAPI produced an empty WAV"
          }
          throw "$failureReason. Install FFmpeg with the flite filter for the local fallback."
        }

        $textFileName = [System.IO.Path]::GetRandomFileName() + ".txt"
        $textPath = [System.IO.Path]::Combine($outputPath, $textFileName)
        [System.IO.File]::WriteAllText(
          $textPath,
          [string]$candidate.phrase,
          [System.Text.UTF8Encoding]::new($false)
        )
        $pushedLocation = $false
        Push-Location -LiteralPath $outputPath
        $pushedLocation = $true
        try {
          & $ffmpegCommand.Source -hide_banner -loglevel error -y -f lavfi `
            -i "flite=textfile=${textFileName}:voice=slt" `
            -ar 24000 -ac 1 -c:a pcm_s16le $fileName 2>&1 | Out-Null
          if ($LASTEXITCODE -ne 0) {
            throw "FFmpeg flite failed to render WAV fixture $fileName."
          }
        } finally {
          if ($pushedLocation) { Pop-Location }
          if ([System.IO.File]::Exists($textPath)) {
            [System.IO.File]::Delete($textPath)
          }
        }
        $usedFfmpegFallback = $true
      } else {
        $usedSapi = $true
      }
      if (-not [System.IO.File]::Exists($wavePath) -or ([System.IO.FileInfo]::new($wavePath)).Length -le 44) {
        throw "TTS produced an empty WAV fixture for $entryId."
      }
      $wavSha = [System.Security.Cryptography.SHA256]::Create()
      try {
        $wavHashBytes = $wavSha.ComputeHash([System.IO.File]::ReadAllBytes($wavePath))
        $wavSha256 = ([System.BitConverter]::ToString($wavHashBytes)).Replace("-", "").ToLowerInvariant()
      } finally {
        $wavSha.Dispose()
      }
      $fixtures.Add([ordered]@{
        fixtureId = [System.IO.Path]::GetFileNameWithoutExtension($fileName)
        entryId = $entryId
        phraseKind = $candidate.kind
        phrase = $candidate.phrase
        targetExact = $targetExact.Trim()
        wavPath = $fileName
        wavSha256 = $wavSha256
      })
    }
  }
  if ($usedSapi -and $usedFfmpegFallback) {
    $manifestGenerator = "Windows SAPI + FFmpeg flite"
    $manifestVoice = "$selectedVoiceDescription + flite:slt"
  } elseif ($usedFfmpegFallback) {
    $manifestGenerator = "FFmpeg flite"
    $manifestVoice = "flite:slt"
  } else {
    $manifestGenerator = "Windows SAPI"
    $manifestVoice = $selectedVoiceDescription
  }


  $manifest = [ordered]@{
    schemaVersion = 2
    generatedAtUtc = [DateTimeOffset]::UtcNow.ToString("O")
    generator = $manifestGenerator
    voice = $manifestVoice
    language = $Language
    audio = [ordered]@{
      container = "wav"
      encoding = "pcm_s16le"
      sampleRateHz = 24000
      channels = 1
      bitsPerSample = 16
    }
    sourceGlossary = [System.IO.Path]::GetFileName($inputPath)
    fixtures = @($fixtures)
  }
  [System.IO.File]::WriteAllText(
    [System.IO.Path]::Combine($outputPath, "manifest.json"),
    ($manifest | ConvertTo-Json -Depth 6) + "`n",
    [System.Text.UTF8Encoding]::new($false)
  )
  Write-Output "Generated $($fixtures.Count) keyless speech fixtures in $outputPath"
  Write-Output "Voice: $manifestVoice"
} finally {
  if ($null -ne $voice) {
    [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($voice)
  }
}
