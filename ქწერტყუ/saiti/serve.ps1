$ErrorActionPreference = 'Stop'
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
  Write-Error 'serve.ps1 requires FullLanguage mode. Use Python http.server or VS Code Live Server in this restricted shell.'
  return
}
$root = [System.IO.Path]::GetFullPath($PSScriptRoot)
$rootPrefix = $root.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add('http://127.0.0.1:4173/')
$listener.Start()
Write-Host "Serving $root at http://127.0.0.1:4173/"
Write-Host 'Press Ctrl+C to stop.'

while ($listener.IsListening) {
  $context = $listener.GetContext()
  try {
    $relativePath = [System.Uri]::UnescapeDataString($context.Request.Url.AbsolutePath.TrimStart('/'))
    if ([string]::IsNullOrWhiteSpace($relativePath)) { $relativePath = 'index.html' }
    $filePath = [System.IO.Path]::GetFullPath((Join-Path $root $relativePath))
    if (-not $filePath.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      $context.Response.StatusCode = 403
      $context.Response.Close()
      continue
    }
    if (-not (Test-Path -LiteralPath $filePath -PathType Leaf)) {
      $context.Response.StatusCode = 404
      $context.Response.Close()
      continue
    }

    $contentType = switch ([System.IO.Path]::GetExtension($filePath).ToLowerInvariant()) {
      '.html' { 'text/html; charset=utf-8' }
      '.css' { 'text/css; charset=utf-8' }
      '.js' { 'text/javascript; charset=utf-8' }
      '.json' { 'application/json; charset=utf-8' }
      '.sql' { 'text/plain; charset=utf-8' }
      '.md' { 'text/plain; charset=utf-8' }
      '.svg' { 'image/svg+xml' }
      default { 'application/octet-stream' }
    }
    $bytes = [System.IO.File]::ReadAllBytes($filePath)
    $context.Response.StatusCode = 200
    $context.Response.ContentType = $contentType
    $context.Response.ContentLength64 = $bytes.Length
    $context.Response.Headers['Cache-Control'] = 'no-store'
    $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $context.Response.Close()
  } catch {
    try {
      $context.Response.StatusCode = 500
      $context.Response.Close()
    } catch { }
  }
}
