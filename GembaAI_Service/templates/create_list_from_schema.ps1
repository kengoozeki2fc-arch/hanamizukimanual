# 汎用リスト作成スクリプト: スキーマJSONファイルを読み込んでリスト作成
# 使い方: pwsh -File ./create_list_from_schema.ps1 -SchemaPath /tmp/xxx_schema.json

param(
    [Parameter(Mandatory=$true)][string]$SchemaPath
)

$ErrorActionPreference = "Continue"
Import-Module PnP.PowerShell

if (-not (Test-Path $SchemaPath)) {
    Write-Host "❌ スキーマファイルが見つかりません: $SchemaPath" -ForegroundColor Red
    exit 1
}
$schema = Get-Content $SchemaPath -Raw | ConvertFrom-Json

Connect-PnPOnline -Url "https://nagaken.sharepoint.com/sites/kyushu-nagaken-face" `
    -DeviceLogin -ClientId "9bc3ab49-b65d-410a-85ad-de819febfddc" -Tenant "b925914f-f4c8-4795-bb3d-07775ad647d1"

Write-Host "✅ 接続成功" -ForegroundColor Green
Write-Host ""

$listInternal = $schema.listInternalName
$listDisplay  = $schema.listDisplayName

# ===== リスト作成 =====
Write-Host "▶ リスト作成: $listDisplay ($listInternal)" -ForegroundColor Cyan
$existing = Get-PnPList -Identity $listDisplay -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "  ⚠ 既存削除: $listDisplay (Id: $($existing.Id))" -ForegroundColor Yellow
    Remove-PnPList -Identity $listDisplay -Force
}

$newList = New-PnPList -Title $listInternal -Template GenericList -OnQuickLaunch
Write-Host "  ✅ リスト作成: Id=$($newList.Id)"

Set-PnPList -Identity $listInternal -Title $listDisplay | Out-Null
Write-Host "  ✅ 表示名変更: $listDisplay"

# ===== Title列を更新 =====
if ($schema.titleFieldXml) {
    Write-Host ""
    Write-Host "▶ Title列を更新" -ForegroundColor Cyan
    $titleXml = $schema.titleFieldXml
    # 表示名を抽出
    $disp = if ($titleXml -match 'DisplayName="([^"]+)"') { $matches[1] } else { "現場名称" }
    # EnforceUniqueValues 抽出
    $enforce = $titleXml -match 'EnforceUniqueValues="TRUE"'
    $indexed = $titleXml -match 'Indexed="TRUE"'
    try {
        $values = @{ Title = $disp; Required = $true }
        if ($enforce) { $values['EnforceUniqueValues'] = $true }
        if ($indexed) { $values['Indexed'] = $true }
        Set-PnPField -List $listDisplay -Identity "Title" -Values $values -ErrorAction Stop
        Write-Host "  ✅ Title → $disp (EnforceUniqueValues=$enforce, Indexed=$indexed)"
    } catch {
        Write-Host "  ❌ Title更新失敗: $($_.Exception.Message)" -ForegroundColor Red
    }
}

# ===== Lookup列追加 =====
if ($schema.lookupFields -and $schema.lookupFields.Count -gt 0) {
    Write-Host ""
    Write-Host "▶ Lookup列追加 ($($schema.lookupFields.Count)列)" -ForegroundColor Cyan

    # 自分自身のID（自己参照Lookup用）
    $selfList = Get-PnPList -Identity $listDisplay
    $selfId = $selfList.Id
    Write-Host "  自分自身のList ID: $selfId"

    foreach ($lk in $schema.lookupFields) {
        $name = $lk.name
        $disp = $lk.displayName
        $targetId = $lk.targetListId
        $req = if ($lk.required) { "TRUE" } else { "FALSE" }

        # 自己参照の場合
        if ($targetId -eq "SELF") {
            $targetId = $selfId.ToString()
        }

        $xml = "<Field Type='Lookup' DisplayName='$disp' Name='$name' StaticName='$name' Required='$req' List='{$targetId}' ShowField='Title' />"
        try {
            Add-PnPFieldFromXml -List $listDisplay -FieldXml $xml -ErrorAction Stop | Out-Null
            Write-Host "  ✚ $name → $disp (target: $($targetId.Substring(0,8))...)" -ForegroundColor Green
        } catch {
            Write-Host "  ❌ $name : $($_.Exception.Message)" -ForegroundColor Red
        }
    }
}

# ===== 各列追加 =====
Write-Host ""
Write-Host "▶ 列追加 ($($schema.fields.Count)列)" -ForegroundColor Cyan
foreach ($f in $schema.fields) {
    $name = $f.name
    $xml = $f.xml
    # ID と SourceID 属性を除去
    $cleanXml = $xml -replace 'ID="\{[^"]+\}"', ''
    $cleanXml = $cleanXml -replace 'SourceID="[^"]+"', ''
    try {
        Add-PnPFieldFromXml -List $listDisplay -FieldXml $cleanXml -ErrorAction Stop | Out-Null
        Write-Host "  ✚ $name" -ForegroundColor Green
    } catch {
        Write-Host "  ❌ $name : $($_.Exception.Message)" -ForegroundColor Red
    }
}

# ===== デフォルトビュー更新 =====
Write-Host ""
Write-Host "▶ デフォルトビュー更新 ($($schema.viewFields.Count)列表示)" -ForegroundColor Cyan
try {
    $view = Get-PnPView -List $listDisplay | Where-Object { $_.DefaultView -eq $true } | Select-Object -First 1
    if ($view) {
        Set-PnPView -List $listDisplay -Identity $view.Id -Fields $schema.viewFields -ErrorAction Stop
        Write-Host "  ✅ ビュー更新成功"
    }
} catch {
    Write-Host "  ❌ ビュー更新失敗: $($_.Exception.Message)" -ForegroundColor Red
}

# ===== データ投入 =====
if ($schema.items -and $schema.items.Count -gt 0) {
    Write-Host ""
    Write-Host "▶ データ投入 ($($schema.items.Count)件)" -ForegroundColor Cyan

    # Lookup解決用のキャッシュ {targetField: @{lookupValue: itemId}}
    $lookupCache = @{}
    if ($schema.lookupResolution) {
        foreach ($lr in $schema.lookupResolution) {
            $lookupCache[$lr.targetField] = @{}
            $listTitle = $lr.lookupListTitle
            $lookupField = $lr.lookupField  # 通常 "Title"
            try {
                $allItems = Get-PnPListItem -List $listTitle -PageSize 5000 -ErrorAction Stop
                foreach ($it in $allItems) {
                    $key = $it[$lookupField]
                    if ($key) {
                        $lookupCache[$lr.targetField][$key] = $it.Id
                    }
                }
                Write-Host "  📚 Lookupキャッシュ: $($lr.targetField) ← $listTitle ($($lookupCache[$lr.targetField].Count)件)" -ForegroundColor Cyan
            } catch {
                Write-Host "  ⚠ Lookupキャッシュ失敗: $listTitle : $($_.Exception.Message)" -ForegroundColor Yellow
            }
        }
    }

    # 列名マッピング (CSVヘッダ → SP内部名)
    $colMap = @{}
    if ($schema.itemColumnMapping) {
        foreach ($prop in $schema.itemColumnMapping.PSObject.Properties) {
            $colMap[$prop.Name] = $prop.Value
        }
    }

    # itemColumnマッピング (Lookup用)
    $lookupColMap = @{}
    if ($schema.lookupResolution) {
        foreach ($lr in $schema.lookupResolution) {
            $lookupColMap[$lr.itemColumn] = $lr.targetField
        }
    }

    $okCount = 0
    $ngCount = 0
    foreach ($item in $schema.items) {
        try {
            $values = @{}
            foreach ($prop in $item.PSObject.Properties) {
                $key = $prop.Name
                $val = $prop.Value
                if ($null -eq $val -or $val -eq "") { continue }

                # Lookup解決
                if ($lookupColMap.ContainsKey($key)) {
                    $targetField = $lookupColMap[$key]
                    $resolvedId = $lookupCache[$targetField][$val]
                    if ($resolvedId) {
                        $values[$targetField] = $resolvedId
                    } else {
                        Write-Host "    ⚠ Lookup未解決: $key='$val' → ID不明" -ForegroundColor Yellow
                    }
                    continue
                }

                # MultiChoice列の値処理 (JSON配列文字列 → 配列)
                $isMulti = $false
                if ($schema.multiChoiceColumns) {
                    foreach ($mc in $schema.multiChoiceColumns) {
                        if ($mc -eq $key) { $isMulti = $true; break }
                    }
                }
                if ($isMulti -and $val -is [string] -and $val.StartsWith('[')) {
                    try {
                        $val = $val | ConvertFrom-Json
                    } catch {}
                }

                # 通常列マッピング
                if ($colMap.ContainsKey($key)) {
                    $values[$colMap[$key]] = $val
                } else {
                    $values[$key] = $val
                }
            }

            $newItem = Add-PnPListItem -List $listDisplay -Values $values -ErrorAction Stop
            $okCount++
        } catch {
            Write-Host "  ❌ $($item.Title) : $($_.Exception.Message)" -ForegroundColor Red
            $ngCount++
        }
    }
    Write-Host "  ✅ 投入: $okCount件 / 失敗: $ngCount件" -ForegroundColor Green
}

# ===== 結果確認 =====
Write-Host ""
Write-Host "▶ 完成リスト" -ForegroundColor Cyan
$finalList = Get-PnPList -Identity $listDisplay
Write-Host "  Title: $($finalList.Title)"
Write-Host "  Url: $($finalList.RootFolder.ServerRelativeUrl)"
Write-Host "  Id: $($finalList.Id)"
Write-Host "  ItemCount: $($finalList.ItemCount)"

$updatedView = Get-PnPView -List $listDisplay | Where-Object { $_.DefaultView -eq $true } | Select-Object -First 1
Write-Host "  ビュー列: $($updatedView.ViewFields -join ', ')"

Disconnect-PnPOnline
Write-Host ""
Write-Host "✅ 完了" -ForegroundColor Green
