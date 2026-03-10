param(
  [string]$InputPath = ".\SECURITY_CHECKLIST.md",
  [string]$OutputPath = ".\SECURITY_CHECKLIST.docx"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $InputPath)) {
  throw "Input file not found: $InputPath"
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Escape-Xml([string]$text) {
  if ($null -eq $text) { return "" }
  return $text.Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;').Replace('"', '&quot;').Replace("'", '&apos;')
}

$lines = Get-Content -LiteralPath $InputPath

$paragraphs = New-Object System.Collections.Generic.List[string]
foreach ($line in $lines) {
  $t = [string]$line
  if ($t.StartsWith('# ')) {
    $paragraphs.Add(("<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>{0}</w:t></w:r></w:p>" -f (Escape-Xml $t.Substring(2).Trim())))
    continue
  }
  if ($t.StartsWith('## ')) {
    $paragraphs.Add(("<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>{0}</w:t></w:r></w:p>" -f (Escape-Xml $t.Substring(3).Trim())))
    continue
  }
  if ($t.StartsWith('- ')) {
    $paragraphs.Add(("<w:p><w:r><w:t xml:space='preserve'>* {0}</w:t></w:r></w:p>" -f (Escape-Xml $t.Substring(2).Trim())))
    continue
  }
  $paragraphs.Add(("<w:p><w:r><w:t xml:space='preserve'>{0}</w:t></w:r></w:p>" -f (Escape-Xml $t)))
}

$documentXml = @"
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas"
 xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
 xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"
 xmlns:v="urn:schemas-microsoft-com:vml"
 xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing"
 xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
 xmlns:w10="urn:schemas-microsoft-com:office:word"
 xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
 xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"
 xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"
 xmlns:wpi="http://schemas.microsoft.com/office/word/2010/wordprocessingInk"
 xmlns:wne="http://schemas.microsoft.com/office/2006/wordml"
 xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"
 mc:Ignorable="w14 wp14">
 <w:body>
  $($paragraphs -join "`n  ")
  <w:sectPr>
   <w:pgSz w:w="12240" w:h="15840"/>
   <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/>
   <w:cols w:space="708"/>
   <w:docGrid w:linePitch="360"/>
  </w:sectPr>
 </w:body>
</w:document>
"@

$contentTypesXml = @"
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="xml" ContentType="application/xml"/>
 <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>
"@

$relsXml = @"
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>
"@

$outDir = Split-Path -Parent $OutputPath
if ([string]::IsNullOrWhiteSpace($outDir)) { $outDir = "." }
if (-not (Test-Path -LiteralPath $outDir)) {
  New-Item -ItemType Directory -Path $outDir | Out-Null
}

$fullOut = Join-Path -Path (Resolve-Path -LiteralPath $outDir) -ChildPath (Split-Path -Leaf $OutputPath)
if (Test-Path -LiteralPath $fullOut) {
  Remove-Item -LiteralPath $fullOut -Force
}

$tmpRoot = Join-Path -Path ([System.IO.Path]::GetTempPath()) -ChildPath ("security-docx-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tmpRoot | Out-Null
New-Item -ItemType Directory -Path (Join-Path $tmpRoot "_rels") | Out-Null
New-Item -ItemType Directory -Path (Join-Path $tmpRoot "word") | Out-Null

Set-Content -LiteralPath (Join-Path $tmpRoot "[Content_Types].xml") -Value $contentTypesXml -Encoding UTF8
Set-Content -LiteralPath (Join-Path $tmpRoot "_rels\.rels") -Value $relsXml -Encoding UTF8
Set-Content -LiteralPath (Join-Path $tmpRoot "word\document.xml") -Value $documentXml -Encoding UTF8

[System.IO.Compression.ZipFile]::CreateFromDirectory($tmpRoot, $fullOut)
Remove-Item -LiteralPath $tmpRoot -Recurse -Force

Write-Host "Created: $fullOut"
