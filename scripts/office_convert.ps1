# office_convert.ps1 - Convert .doc / .xls to text via Word/Excel COM.
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File office_convert.ps1 <listfile> <outfile>
# listfile: one absolute path per line (.doc or .xls)
# outfile:  UTF-8 JSONL output, one record per line:
#           {"path":..., "ext":..., "rel":..., "text":...}

param(
  [Parameter(Mandatory=$true)][string]$ListFile,
  [Parameter(Mandatory=$true)][string]$OutFile
)

$ErrorActionPreference = "Stop"

function Get-Rel([string]$p) {
  $root = "D:\IPAV"
  $full = [System.IO.Path]::GetFullPath($p)
  $rootFull = [System.IO.Path]::GetFullPath($root)
  if ($full.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
    return $full.Substring($rootFull.Length).TrimStart("\")
  }
  return $full
}

$lines = @(Get-Content -Path $ListFile -Encoding UTF8 | Where-Object { $_.Trim() -ne "" })

$results = New-Object System.Collections.Generic.List[string]

$word = $null
$excel = $null
$doc = $null
$wb = $null

foreach ($line in $lines) {
  $src = $line.Trim()
  $ext = [System.IO.Path]::GetExtension($src).ToLower()
  if (-not (Test-Path -LiteralPath $src)) { continue }
  try {
    if ($ext -eq ".doc") {
      if ($null -eq $word) {
        $word = New-Object -ComObject Word.Application
        $word.Visible = $false
        $word.DisplayAlerts = 0
      }
      $doc = $word.Documents.Open($src, $false, $true)
      $text = $doc.Content.Text
      $doc.Close($false)
      $result = @{ path = $src; ext = $ext; rel = (Get-Rel $src); text = $text } | ConvertTo-Json -Compress
      $results.Add($result)
    } elseif ($ext -eq ".xls") {
      if ($null -eq $excel) {
        $excel = New-Object -ComObject Excel.Application
        $excel.Visible = $false
        $excel.DisplayAlerts = $false
      }
      $wb = $excel.Workbooks.Open($src, 0, $true)
      $sb = New-Object System.Text.StringBuilder
      foreach ($ws in $wb.Worksheets) {
        $val = $ws.UsedRange.Value2
        if ($null -eq $val) { continue }
        if ($val -is [object[,]]) {
          $rows = $val.GetLength(0); $cols = $val.GetLength(1)
          for ($r = 1; $r -le $rows; $r++) {
            $cells = @()
            for ($c = 1; $c -le $cols; $c++) {
              $v = $val[$r, $c]
              if ($null -ne $v -and "$v".Trim() -ne "") { $cells += "$v".Trim() }
            }
            if ($cells.Count -gt 0) { [void]$sb.AppendLine(($cells -join " | ")) }
          }
        } else {
          if ("$val".Trim() -ne "") { [void]$sb.AppendLine("$val".Trim()) }
        }
      }
      $wb.Close($false)
      $result = @{ path = $src; ext = $ext; rel = (Get-Rel $src); text = $sb.ToString() } | ConvertTo-Json -Compress
      $results.Add($result)
    }
  } catch {
    [Console]::Error.WriteLine("WARN $src $($_.Exception.Message)")
    try { if ($doc) { $doc.Close($false) } } catch {}
    try { if ($wb) { $wb.Close($false) } } catch {}
    $doc = $null; $wb = $null
  }
}

try { if ($word) { $word.Quit() } } catch {}
try { if ($excel) { $excel.Quit() } } catch {}

$enc = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllLines($OutFile, $results, $enc)
$count = $results.Count
Write-Output "DONE $count records -> $OutFile"