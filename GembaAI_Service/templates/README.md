# GembaAI_Service テンプレート集

新企業（テナント）追加時に使う各種テンプレートとスクリプト。

## ファイル一覧

| ファイル | 用途 |
|---|---|
| `provision-gembaai-lists.ps1` | 8リスト一括作成スクリプト（旧版・固定スキーマ） |
| **`create_list_from_schema.ps1`** | ★汎用リスト作成スクリプト（CSVスキーマ方式） |
| **`csv_to_schema.py`** | ★SPO ExportToCSV → スキーマJSON 変換 |
| `gembaai-site-script.json` | SPO Site Script（管理者デプロイ用） |
| `nfc-tags-template.docx` | NFC台紙ひな形 |
| `pre-registration-flyer.docx` | 事前登録案内チラシひな形 |
| `new-entry-guide.docx` | 新規入場者ガイドひな形 |

---

## 🚀 標準ワークフロー：永賢組サイトを元に新テナントへ8リストを再現

### 前提
- 永賢組サイト (`constructioninfo`) で各リストを「Excelにエクスポート」または ExportToCSV
- 新サイト (`kyushu-nagaken-face` 等) を作成済み・自分が所有者
- PowerShell 7+ と PnP.PowerShell 3.x がインストール済み

### 手順

#### 1. CSVを取得
SPOで対象リストを開き、「コマンドバー → ⋯ → Excelにエクスポート」でCSVをダウンロード。

#### 2. CSV → スキーマJSON 変換
```bash
python3 csv_to_schema.py 現場.csv OnsiteMaster 現場 /tmp/onsite_schema.json
```

#### 3. （必要なら）JSONを手動編集
Lookup列・MultiChoice列・列名マッピング・データ投入時のID解決設定を追加。

**例: 危険回避策（Lookup付き）**
```json
{
  "lookupFields": [
    {
      "name": "RiskyWorkID",
      "displayName": "危険作業",
      "targetListId": "48e1327d-1406-403a-b6b8-231d2dd234fd",
      "required": true
    }
  ],
  "lookupResolution": [
    {
      "itemColumn": "危険作業",
      "targetField": "RiskyWorkID",
      "lookupListTitle": "危険作業",
      "lookupField": "Title"
    }
  ],
  "itemColumnMapping": {
    "危険回避策": "Title"
  }
}
```

**例: 社員（MultiChoice + 3 Lookup）**
```json
{
  "lookupFields": [
    { "name": "QualificationID1", "displayName": "社員資格ID1", "targetListId": "<id>", "required": false },
    { "name": "QualificationID2", "displayName": "社員資格ID2", "targetListId": "<id>", "required": false },
    { "name": "QualificationID3", "displayName": "社員資格ID3", "targetListId": "<id>", "required": false }
  ],
  "lookupResolution": [
    { "itemColumn": "社員資格ID1", "targetField": "QualificationID1", "lookupListTitle": "社員資格", "lookupField": "Title" },
    { "itemColumn": "社員資格ID2", "targetField": "QualificationID2", "lookupListTitle": "社員資格", "lookupField": "Title" },
    { "itemColumn": "社員資格ID3", "targetField": "QualificationID3", "lookupListTitle": "社員資格", "lookupField": "Title" }
  ],
  "itemColumnMapping": {
    "氏名": "Title",
    "メールアドレス": "MailAddress"
  },
  "multiChoiceColumns": ["権限ロール"]
}
```

**例: OnsitePartnerRelation（自己参照Lookup）**
```json
{
  "lookupFields": [
    { "name": "OnsiteID", "displayName": "現場", "targetListId": "<OnsiteMaster id>", "required": true },
    { "name": "PartnerID", "displayName": "協力業者", "targetListId": "<PartnerMaster id>", "required": true },
    { "name": "ParentOnsitePartnerID", "displayName": "上位協力業者", "targetListId": "SELF", "required": false }
  ]
}
```
※ `"targetListId": "SELF"` を指定すると、PSスクリプトが自分自身のIDで自動置換します。

#### 4. PnPスクリプト実行
```bash
pwsh -File ./create_list_from_schema.ps1 -SchemaPath /tmp/onsite_schema.json
```

実行内容:
1. `system-survey@nagaken.com` で DeviceLogin 認証
2. リスト作成（既存なら削除→再作成）
3. Title列を更新（DisplayName/EnforceUniqueValues/Indexed/Required）
4. Lookup列を追加（自己参照は自動解決）
5. 通常列を追加（CSVのSchemaXmlをそのまま使用）
6. デフォルトビューに全列を追加（`Set-PnPView -Fields`）
7. データ投入（Lookup ID解決＋MultiChoice配列化）

#### 5. 投入順序（依存関係）

参照先のリストを先に作る必要がある:

```
[1] 現場 (OnsiteMaster)
[2] 協力業者 (PartnerMaster)
[3] 社員資格 (EmployeeQualificationMaster)
[4] 危険作業 (RiskyWorkMaster)
        ↓
[5] 現場協力業者紐付け (OnsitePartnerRelation)
    ├─ Lookup → OnsiteMaster
    ├─ Lookup → PartnerMaster
    └─ Lookup → 自分自身（SELF）
        ↓
[6] 社員 (EmployeeMaster)
    └─ Lookup × 3 → EmployeeQualificationMaster
        ↓
[7] 社員実績 (EmployeeAchievement)
    ├─ Lookup → EmployeeMaster
    └─ Lookup → OnsiteMaster
        ↓
[8] 危険回避策 (RiskAvoidanceMaster)
    └─ Lookup → RiskyWorkMaster
```

---

## 📚 永賢組テナントでの実証済み認証方法

```powershell
Connect-PnPOnline `
    -Url "https://nagaken.sharepoint.com/sites/<site-name>" `
    -DeviceLogin `
    -ClientId "9bc3ab49-b65d-410a-85ad-de819febfddc" `   # SharePoint Online Management Shell
    -Tenant "b925914f-f4c8-4795-bb3d-07775ad647d1"
```

- ClientId `9bc3ab49-...` = 永賢組テナントに事前登録済み
- DeviceLogin → ターミナルにコード表示 → ブラウザで認証
- `system-survey@nagaken.com`（Global Admin・MFAなし）で動作確認済み

---

## ⚠️ ハマりポイント

### 1. PnP の `-Identity` は日本語Title推奨
URL名（`OnsiteMaster`）では取れないことがある。日本語Title（`現場`）か GUID で渡す。

### 2. デフォルトビューには列が自動追加されない
`Add-PnPFieldFromXml` で追加した列はリスト内部にはあるが、「すべてのアイテム」には表示されない。`Set-PnPView -Fields` で明示的に追加する必要あり。`Add-PnPViewField` cmdlet は PnP.PowerShell 3.x には存在しない。

### 3. Lookup列はSchemaXmlListに含まれない
SPOのCSVエクスポートではLookup列のSchemaXmlは含まれない。手動で `lookupFields` を定義する。

### 4. MultiChoice の値はJSON配列文字列
CSVの値が `["現場管理者"]` 形式。`ConvertFrom-Json` で配列化してから渡す。

### 5. Lookup列のデータ投入はID解決必須
表示名（"齊藤 武"）ではなく内部アイテムID（数値）が必要。参照先リスト全件を `Get-PnPListItem -PageSize 5000` でキャッシュしてから解決する。

---

## 🔗 関連リソース

- HTMLマニュアル: https://manual.kensetsu-total.support/GembaAI_Service/step04-master-lists.html
- メモリ: `~/.claude/projects/-Users-kengoozeki/memory/feedback_pnp_powershell_nagaken.md`
- プロジェクト: `~/.claude/projects/-Users-kengoozeki/memory/project_kyushu_eikengumi_onboarding.md`
