<#
.SYNOPSIS
  GembaAI Service - 8マスタリスト一括プロビジョニングスクリプト

.DESCRIPTION
  新規テナント用のSharePointサイトに、入退場管理システムで必要な
  8種類のSPOリスト（OnsiteMaster / PartnerMaster / OnsitePartnerRelation /
  EmployeeMaster / EmployeeQualificationMaster / EmployeeAchievement /
  RiskyWorkMaster / RiskAvoidanceMaster）を作成します。

  全列定義は永賢組サイト(constructioninfo)からMicrosoft Graph APIで取得した
  実装ベースの定義に基づきます（2026-04-09時点）。

.PREREQUISITES
  - PowerShell 7+
  - PnP.PowerShell モジュール
    Install-Module -Name PnP.PowerShell -Scope CurrentUser -Force
  - 対象SPOサイトへの所有者(フルコントロール)権限

.USAGE
  pwsh -File ./provision-gembaai-lists.ps1 -SiteUrl "https://nagaken.sharepoint.com/sites/constructioninfoKyushu"

.NOTES
  Lookup列は参照先リスト作成後に動的に解決します。
  実行順序: OnsiteMaster → PartnerMaster → 社員資格 → 危険作業
            → OnsitePartnerRelation → 社員 → 社員実績 → 危険回避策
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)]
    [string]$SiteUrl
)

# ========== 共通: PnP接続 ==========
Write-Host "▶ Connecting to $SiteUrl ..." -ForegroundColor Cyan
Connect-PnPOnline -Url $SiteUrl -Interactive -ErrorAction Stop

# ========== ヘルパー関数 ==========
function Add-OrSkipList {
    param([string]$Title, [string]$Url, [string]$Template = "GenericList")
    $list = Get-PnPList -Identity $Url -ErrorAction SilentlyContinue
    if ($list) {
        Write-Host "  ⏭  既存: $Title" -ForegroundColor Yellow
        return $list
    }
    Write-Host "  ✚ 作成: $Title ($Url)" -ForegroundColor Green
    return New-PnPList -Title $Title -Url $Url -Template $Template -OnQuickLaunch
}

function Add-TextField {
    param([string]$List, [string]$InternalName, [string]$DisplayName, [bool]$Required = $false)
    Add-PnPField -List $List -InternalName $InternalName -DisplayName $DisplayName -Type Text -Required:$Required -ErrorAction SilentlyContinue | Out-Null
}

function Add-NumberField {
    param([string]$List, [string]$InternalName, [string]$DisplayName, [bool]$Required = $false)
    Add-PnPField -List $List -InternalName $InternalName -DisplayName $DisplayName -Type Number -Required:$Required -ErrorAction SilentlyContinue | Out-Null
}

function Add-DateField {
    param([string]$List, [string]$InternalName, [string]$DisplayName, [bool]$Required = $false)
    Add-PnPField -List $List -InternalName $InternalName -DisplayName $DisplayName -Type DateTime -Required:$Required -ErrorAction SilentlyContinue | Out-Null
}

function Add-BoolField {
    param([string]$List, [string]$InternalName, [string]$DisplayName)
    Add-PnPField -List $List -InternalName $InternalName -DisplayName $DisplayName -Type Boolean -ErrorAction SilentlyContinue | Out-Null
}

function Add-ChoiceField {
    param([string]$List, [string]$InternalName, [string]$DisplayName, [string[]]$Choices, [bool]$Required = $false, [bool]$MultiChoice = $false)
    $type = if ($MultiChoice) { "MultiChoice" } else { "Choice" }
    Add-PnPField -List $List -InternalName $InternalName -DisplayName $DisplayName -Type $type -Choices $Choices -Required:$Required -ErrorAction SilentlyContinue | Out-Null
}

function Add-LookupFieldByListName {
    param([string]$List, [string]$InternalName, [string]$DisplayName, [string]$LookupListUrl, [bool]$Required = $false)
    $lookupList = Get-PnPList -Identity $LookupListUrl
    if (-not $lookupList) {
        Write-Warning "Lookup target list not found: $LookupListUrl"
        return
    }
    Add-PnPField -List $List -InternalName $InternalName -DisplayName $DisplayName -Type Lookup -ErrorAction SilentlyContinue | Out-Null
    # Note: PnP の Add-PnPField は Lookup 詳細指定がやや弱いため、
    # 作成後に Set-PnPField で参照リスト/列を補正する
    $field = Get-PnPField -List $List -Identity $InternalName -ErrorAction SilentlyContinue
    if ($field) {
        $schemaXml = "<Field Type='Lookup' DisplayName='$DisplayName' List='{$($lookupList.Id)}' ShowField='Title' />"
        Set-PnPField -List $List -Identity $InternalName -Values @{ SchemaXml = $schemaXml } -ErrorAction SilentlyContinue
    }
}

# ========== 1. OnsiteMaster (現場) ==========
Write-Host "`n[1/8] OnsiteMaster (現場)" -ForegroundColor Magenta
$null = Add-OrSkipList -Title "現場" -Url "Lists/OnsiteMaster"
Add-TextField   -List "OnsiteMaster" -InternalName "ChiefName"                     -DisplayName "所長名"
Add-DateField   -List "OnsiteMaster" -InternalName "ConstructionStartDate"         -DisplayName "工期（自）"
Add-DateField   -List "OnsiteMaster" -InternalName "ConstructionEndDate"           -DisplayName "工期（至）"
Add-NumberField -List "OnsiteMaster" -InternalName "InsuranceNumber"               -DisplayName "労災保険番号"
Add-BoolField   -List "OnsiteMaster" -InternalName "OfficeEstablishmentSubmission" -DisplayName "事業所の設置届提出済"
Add-BoolField   -List "OnsiteMaster" -InternalName "ScaffoldingSubmission"         -DisplayName "足場支保工提出済"
Add-BoolField   -List "OnsiteMaster" -InternalName "FalseworkSubmission"           -DisplayName "型枠支保工提出済"
Add-TextField   -List "OnsiteMaster" -InternalName "Abbreviation"                  -DisplayName "略称ローマ字"

# ========== 2. PartnerMaster (協力業者) ==========
Write-Host "`n[2/8] PartnerMaster (協力業者)" -ForegroundColor Magenta
$null = Add-OrSkipList -Title "協力業者" -Url "Lists/PartnerMaster"
Add-TextField   -List "PartnerMaster" -InternalName "PostCode"                   -DisplayName "郵便番号"
Add-TextField   -List "PartnerMaster" -InternalName "Address"                    -DisplayName "住所"
Add-TextField   -List "PartnerMaster" -InternalName "MainPhoneNumber"            -DisplayName "代表電話番号"
Add-TextField   -List "PartnerMaster" -InternalName "RepresentativeName"         -DisplayName "代表者名"
Add-TextField   -List "PartnerMaster" -InternalName "PersonInChargeName"         -DisplayName "担当者名"
Add-TextField   -List "PartnerMaster" -InternalName "DepartmentInCharge"         -DisplayName "担当者部署"
Add-TextField   -List "PartnerMaster" -InternalName "PersonInChargePosition"     -DisplayName "担当者役職"
Add-TextField   -List "PartnerMaster" -InternalName "PersonInChargeMobileNumber" -DisplayName "担当者携帯番号"
Add-TextField   -List "PartnerMaster" -InternalName "PersonInChargeEmailAddress" -DisplayName "担当者メールアドレス"
Add-TextField   -List "PartnerMaster" -InternalName "ConstructionLicenseNumber"  -DisplayName "建設業許可番号"
Add-ChoiceField -List "PartnerMaster" -InternalName "ConstructionLicenseType"    -DisplayName "建設業許可業種" -MultiChoice $true -Choices @(
    "土木一式工事","建築一式工事","大工工事","左官工事","とび・土工・コンクリート工事","石工事","屋根工事","電気工事","管工事",
    "タイル・れんが・ブロック工事","鋼構造物工事","鉄筋工事","舗装工事","しゅんせつ工事","板金工事","ガラス工事","塗装工事",
    "防水工事","内装仕上工事","機械器具設置工事","熱絶縁工事","電気通信工事","造園工事","さく井工事","建具工事","水道施設工事",
    "消防施設工事","清掃施設工事","解体工事"
)
Add-ChoiceField -List "PartnerMaster" -InternalName "ContractType"        -DisplayName "契約形態"             -Choices @("直契約","再下請")
Add-TextField   -List "PartnerMaster" -InternalName "IntroductionCompany" -DisplayName "初期紹介会社"
Add-ChoiceField -List "PartnerMaster" -InternalName "HealthInsurance"     -DisplayName "健康保険"             -Choices @("健康保険組合","協会けんぽ","建設国保","国民健康保険")
Add-ChoiceField -List "PartnerMaster" -InternalName "PensionInsurance"    -DisplayName "年金保険"             -Choices @("厚生年金","国民年金")
Add-ChoiceField -List "PartnerMaster" -InternalName "EmploymentInsurance" -DisplayName "雇用保険"             -Choices @("加入","日雇保険")
Add-ChoiceField -List "PartnerMaster" -InternalName "KentaikyoSystem"     -DisplayName "建設業退職金共済制度" -Choices @("有","無")
Add-ChoiceField -List "PartnerMaster" -InternalName "SMBtaikyoSystem"     -DisplayName "中小企業退職金共済制度" -Choices @("有","無")

# Title を 協力業者名称 にリネーム
Set-PnPField -List "PartnerMaster" -Identity "Title" -Values @{ Title = "協力業者名称" } -ErrorAction SilentlyContinue

# ========== 3. EmployeeQualificationMaster (社員資格) ==========
Write-Host "`n[3/8] EmployeeQualificationMaster (社員資格)" -ForegroundColor Magenta
$null = Add-OrSkipList -Title "社員資格" -Url "Lists/EmployeeQualificationMaster"
Set-PnPField -List "EmployeeQualificationMaster" -Identity "Title" -Values @{ Title = "資格名称" } -ErrorAction SilentlyContinue

# ========== 4. RiskyWorkMaster (危険作業) ==========
Write-Host "`n[4/8] RiskyWorkMaster (危険作業)" -ForegroundColor Magenta
$null = Add-OrSkipList -Title "危険作業" -Url "Lists/RiskyWorkMaster"
Set-PnPField -List "RiskyWorkMaster" -Identity "Title" -Values @{ Title = "危険作業" } -ErrorAction SilentlyContinue

# ========== 5. OnsitePartnerRelation (現場協力業者紐付け) ==========
Write-Host "`n[5/8] OnsitePartnerRelation (現場協力業者紐付け)" -ForegroundColor Magenta
$null = Add-OrSkipList -Title "現場協力業者紐付け" -Url "Lists/OnsitePartnerRelation"
Add-LookupFieldByListName -List "OnsitePartnerRelation" -InternalName "OnsiteID"               -DisplayName "現場"           -LookupListUrl "Lists/OnsiteMaster"          -Required $true
Add-LookupFieldByListName -List "OnsitePartnerRelation" -InternalName "PartnerID"              -DisplayName "協力業者"       -LookupListUrl "Lists/PartnerMaster"         -Required $true
Add-LookupFieldByListName -List "OnsitePartnerRelation" -InternalName "ParentOnsitePartnerID"  -DisplayName "上位協力業者"   -LookupListUrl "Lists/OnsitePartnerRelation"
Add-NumberField -List "OnsitePartnerRelation" -InternalName "Hierarchy" -DisplayName "階層"
Add-ChoiceField -List "OnsitePartnerRelation" -InternalName "PartnerWork" -DisplayName "協力業者担当作業" -Choices @(
    "直接仮設工事","土工事","山留・乗入構台工事","杭地業工事","コンクリート工事","型枠工事","鉄筋工事","鉄骨工事","組積工事",
    "防水工事","石工事","タイル工事","木工事","屋根工事","外壁工事","金属工事","左官工事","木製建具工事","金属製建具工事",
    "ガラス工事","塗装工事","内装工事","住設工事","家具工事","断熱・耐火被覆工事","パーテーション工事","サイン工事","外構工事",
    "造園工事","EV工事","電気設備工事","給排水設備工事","空調換気設備工事","ガス設備工事","解体工事","雑工事","その他設備工事"
)

# ========== 6. EmployeeMaster (社員) ==========
Write-Host "`n[6/8] EmployeeMaster (社員)" -ForegroundColor Magenta
$null = Add-OrSkipList -Title "社員" -Url "Lists/EmployeeMaster"
Set-PnPField -List "EmployeeMaster" -Identity "Title" -Values @{ Title = "氏名" } -ErrorAction SilentlyContinue
Add-TextField   -List "EmployeeMaster" -InternalName "MailAddress"                 -DisplayName "メールアドレス"
Add-DateField   -List "EmployeeMaster" -InternalName "BirthDate"                   -DisplayName "生年月日"
Add-ChoiceField -List "EmployeeMaster" -InternalName "Role"                        -DisplayName "権限ロール" -Choices @("現場管理者","本社管理者","システム管理者")
Add-TextField   -List "EmployeeMaster" -InternalName "MobileNumber"                -DisplayName "携帯電話番号"
Add-LookupFieldByListName -List "EmployeeMaster" -InternalName "QualificationID1"  -DisplayName "社員資格ID1" -LookupListUrl "Lists/EmployeeQualificationMaster"
Add-TextField   -List "EmployeeMaster" -InternalName "QualifiedPersonNumber1"      -DisplayName "資格者番号1"
Add-DateField   -List "EmployeeMaster" -InternalName "QualificationDeadline1"      -DisplayName "資格期限1"
Add-LookupFieldByListName -List "EmployeeMaster" -InternalName "QualificationID2"  -DisplayName "社員資格ID2" -LookupListUrl "Lists/EmployeeQualificationMaster"
Add-TextField   -List "EmployeeMaster" -InternalName "QualifiedPersonNumber2"      -DisplayName "資格者番号2"
Add-DateField   -List "EmployeeMaster" -InternalName "QualificationDeadline2"      -DisplayName "資格期限2"
Add-LookupFieldByListName -List "EmployeeMaster" -InternalName "QualificationID3"  -DisplayName "社員資格ID3" -LookupListUrl "Lists/EmployeeQualificationMaster"
Add-TextField   -List "EmployeeMaster" -InternalName "QualifiedPersonNumber3"      -DisplayName "資格者番号3"
Add-DateField   -List "EmployeeMaster" -InternalName "QualificationDeadline3"      -DisplayName "資格期限3"
Add-NumberField -List "EmployeeMaster" -InternalName "ConstructionManagerNumber"   -DisplayName "監理技術者番号"
Add-DateField   -List "EmployeeMaster" -InternalName "ConstructionManagerDeadline" -DisplayName "更新期限"
Add-PnPField -List "EmployeeMaster" -InternalName "CPDAchievements" -DisplayName "CPD実績" -Type Note -ErrorAction SilentlyContinue | Out-Null

# ========== 7. EmployeeAchievement (社員実績) ==========
Write-Host "`n[7/8] EmployeeAchievement (社員実績)" -ForegroundColor Magenta
$null = Add-OrSkipList -Title "社員実績" -Url "Lists/EmployeeAchievement"
Add-LookupFieldByListName -List "EmployeeAchievement" -InternalName "EmployeeID" -DisplayName "社員" -LookupListUrl "Lists/EmployeeMaster" -Required $true
Add-LookupFieldByListName -List "EmployeeAchievement" -InternalName "OnsiteID"   -DisplayName "現場" -LookupListUrl "Lists/OnsiteMaster"   -Required $true
Add-DateField -List "EmployeeAchievement" -InternalName "AssignmentStartDate" -DisplayName "所属期間（自）"
Add-DateField -List "EmployeeAchievement" -InternalName "AssignmentEndDate"   -DisplayName "所属期間（至）"
Add-ChoiceField -List "EmployeeAchievement" -InternalName "ConstructionWorkInCharge" -DisplayName "担当工事" -Choices @(
    "直接仮設工事","土工事","山留・乗入構台工事","杭地業工事","コンクリート工事","型枠工事","鉄筋工事","鉄骨工事","組積工事",
    "防水工事","石工事","タイル工事","木工事","屋根工事","外壁工事","金属工事","左官工事","木製建具工事","金属製建具工事",
    "ガラス工事","塗装工事","内装工事","住設工事","家具工事","断熱・耐火被覆工事","パーテーション工事","サイン工事","外構工事",
    "造園工事","EV工事","電気設備工事","給排水設備工事","空調換気設備工事","ガス設備工事","解体工事","雑工事","その他設備工事"
)

# ========== 8. RiskAvoidanceMaster (危険回避策) ==========
Write-Host "`n[8/8] RiskAvoidanceMaster (危険回避策)" -ForegroundColor Magenta
$null = Add-OrSkipList -Title "危険回避策" -Url "Lists/RiskAvoidanceMaster"
Set-PnPField -List "RiskAvoidanceMaster" -Identity "Title" -Values @{ Title = "危険回避策" } -ErrorAction SilentlyContinue
Add-LookupFieldByListName -List "RiskAvoidanceMaster" -InternalName "RiskyWorkID" -DisplayName "危険作業" -LookupListUrl "Lists/RiskyWorkMaster" -Required $true

# ========== 完了 ==========
Write-Host "`n✅ All 8 lists provisioned successfully!" -ForegroundColor Green
Write-Host "  確認URL: $SiteUrl/_layouts/15/viewlsts.aspx"
Disconnect-PnPOnline
