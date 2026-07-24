$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$pluginRoot = Join-Path $projectRoot "eagle-plugin"
$engineRoot = Join-Path $pluginRoot "engine"
$outputRoot = Join-Path (Split-Path -Parent (Split-Path -Parent $projectRoot)) "outputs"
$manifest = Get-Content (Join-Path $pluginRoot "manifest.json") -Raw | ConvertFrom-Json
$version = $manifest.version
$packagePath = Join-Path $outputRoot "ds-Eagle-Tagger-$version.eagleplugin"

# The root catalog is the public online source; keep the bundled catalog in sync
# without duplicating the Python engine source at the repository root.
Copy-Item -LiteralPath (Join-Path $projectRoot "model-catalog.json") -Destination (Join-Path $engineRoot "model-catalog.json") -Force

$required = @(
  (Join-Path $pluginRoot "manifest.json"),
  (Join-Path $pluginRoot "index.html"),
  (Join-Path $pluginRoot "plugin.js"),
  (Join-Path $engineRoot "tools\uv.exe"),
  (Join-Path $engineRoot "licenses\uv-LICENSE-MIT.txt"),
  (Join-Path $engineRoot "licenses\uv-LICENSE-APACHE.txt")
)
foreach ($file in $required) {
  if (-not (Test-Path -LiteralPath $file)) { throw "缺少公开包文件：$file" }
}

New-Item -ItemType Directory -Force $outputRoot | Out-Null
if (Test-Path -LiteralPath $packagePath) { Remove-Item -LiteralPath $packagePath -Force }

# Compress-Archive and ZipFile.CreateFromDirectory write Windows separators
# into ZIP entry names. Eagle's yauzl extractor rejects entries such as
# engine\config.json, so each entry is created with an explicit portable path.
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$compressionAssembly = [AppDomain]::CurrentDomain.GetAssemblies() |
  Where-Object { $_.GetName().Name -eq "System.IO.Compression" } |
  Select-Object -First 1
$zipArchiveType = $compressionAssembly.GetType("System.IO.Compression.ZipArchive", $true)
$zipArchiveModeType = $compressionAssembly.GetType("System.IO.Compression.ZipArchiveMode", $true)
$createMode = [Enum]::Parse($zipArchiveModeType, "Create")
$packageStream = [System.IO.File]::Open(
  $packagePath,
  [System.IO.FileMode]::CreateNew,
  [System.IO.FileAccess]::ReadWrite,
  [System.IO.FileShare]::None
)
$archive = [Activator]::CreateInstance(
  $zipArchiveType,
  [object[]]@($packageStream, $createMode, $false)
)
$pluginPrefix = $pluginRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
try {
  Get-ChildItem -LiteralPath $pluginRoot -Recurse -File |
    Where-Object {
      $_.Extension -ne ".pyc" -and
      $_.FullName -notmatch "[\\/]+__pycache__[\\/]+"
    } |
    ForEach-Object {
    $relativePath = $_.FullName.Substring($pluginPrefix.Length).Replace("\", "/")
    $entry = $archive.CreateEntry($relativePath, [System.IO.Compression.CompressionLevel]::Optimal)
    $entry.LastWriteTime = $_.LastWriteTime
    $entryStream = $entry.Open()
    $sourceStream = $_.OpenRead()
    try {
      $sourceStream.CopyTo($entryStream)
    }
    finally {
      $sourceStream.Dispose()
      $entryStream.Dispose()
    }
    }
}
finally {
  $archive.Dispose()
  $packageStream.Dispose()
}

# Fail the build immediately if a future packaging change creates an archive
# that Eagle cannot install.
$archive = [System.IO.Compression.ZipFile]::OpenRead($packagePath)
try {
  $entryNames = @($archive.Entries | ForEach-Object { $_.FullName })
  $invalidEntries = @($entryNames | Where-Object { $_.Contains("\") })
  if ($invalidEntries.Count -gt 0) {
    throw "ZIP contains invalid Windows path separators: $($invalidEntries -join ', ')"
  }
  foreach ($requiredEntry in @("manifest.json", "index.html", "plugin.js", "engine/config.json", "engine/tools/uv.exe")) {
    if ($entryNames -notcontains $requiredEntry) {
      throw "ZIP is missing required entry: $requiredEntry"
    }
  }
}
finally {
  $archive.Dispose()
}

$sizeMb = [math]::Round((Get-Item -LiteralPath $packagePath).Length / 1MB, 2)
Write-Host "已生成：$packagePath ($sizeMb MB)"
