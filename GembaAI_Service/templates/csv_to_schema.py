#!/usr/bin/env python3
"""
SharePoint Online の ExportToCSV 形式の CSV から ListSchema と data 行を抽出し、
create_list_from_schema.ps1 が読み込める JSON 形式に変換するスクリプト。

使い方:
    python3 csv_to_schema.py <CSV_PATH> <INTERNAL_NAME> <DISPLAY_NAME> [OUTPUT_PATH]

例:
    python3 csv_to_schema.py 現場.csv OnsiteMaster 現場 /tmp/onsite_schema.json

出力されたJSONを手動編集して、必要に応じて以下を追加:
  - "lookupFields": [...]            # Lookup列の定義（参照先listId必須）
  - "lookupResolution": [...]        # データ投入時の表示名→ID解決設定
  - "itemColumnMapping": {...}       # CSVヘッダ → SP内部名のマッピング
  - "multiChoiceColumns": [...]      # JSON配列文字列を配列化する列名
"""

import json
import re
import csv
import io
import sys
import os


def extract_schema(csv_path: str) -> dict:
    """CSV から ListSchema を抽出してパース"""
    text = open(csv_path, encoding='utf-8-sig').read()
    m = re.search(r'ListSchema=(\{.*?"\]\})', text, re.S)
    if not m:
        raise ValueError("ListSchema が CSV から見つかりません")
    return json.loads(m.group(1)), text[m.end():].lstrip()


def parse_fields(schema: dict) -> tuple:
    """SchemaXmlList を解析して title_field と非Lookup通常列を返す"""
    COMPUTED_NAMES = {'LinkTitle', 'LinkTitleNoMenu', 'LinkTitle2'}
    title_field = None
    non_lookup_fields = []

    for xml in schema['schemaXmlList']:
        nm = re.search(r'\bName="([^"]+)"', xml)
        type_m = re.search(r'\bType="([^"]+)"', xml)
        if not nm:
            continue
        name = nm.group(1)
        ftype = type_m.group(1) if type_m else ''
        if ftype == 'Computed' or name in COMPUTED_NAMES:
            continue
        if ftype == 'Lookup':
            # Lookup列はSchemaXmlListに含まれないことが多いが念のためスキップ
            # （含まれていても参照先listIdが元サイトのものなので使えない）
            continue
        if name == 'Title':
            title_field = xml
            continue
        non_lookup_fields.append({"name": name, "xml": xml})

    return title_field, non_lookup_fields


def parse_data(data_text: str) -> tuple:
    """データ行をパースして items リストとヘッダを返す"""
    reader = csv.reader(io.StringIO(data_text))
    rows = list(reader)
    if not rows:
        return [], []
    header = rows[0]
    data = rows[1:]
    items = []
    for r in data:
        if not r or not any(r):
            continue
        item = {}
        for i, h in enumerate(header):
            if i >= len(r):
                continue
            if h == 'ID':  # SP内部ID列はスキップ
                continue
            if not r[i]:
                continue
            item[h] = r[i]
        items.append(item)
    return items, header


def main():
    if len(sys.argv) < 4:
        print(__doc__)
        sys.exit(1)

    csv_path = sys.argv[1]
    internal_name = sys.argv[2]
    display_name = sys.argv[3]
    output_path = sys.argv[4] if len(sys.argv) >= 5 else f"/tmp/{internal_name.lower()}_schema.json"

    if not os.path.exists(csv_path):
        print(f"❌ CSVが見つかりません: {csv_path}")
        sys.exit(1)

    schema, data_text = extract_schema(csv_path)
    title_field, fields = parse_fields(schema)
    items, header = parse_data(data_text)

    # ビュー列はLinkTitle + 通常列
    view_fields = ["LinkTitle"] + [f["name"] for f in fields]

    output = {
        "listInternalName": internal_name,
        "listDisplayName": display_name,
        "titleFieldXml": title_field,
        "fields": fields,
        "lookupFields": [],          # 必要に応じて手動追加
        "viewFields": view_fields,   # 必要に応じて並び順調整
        "items": items,
        "itemColumnMapping": {},     # 必要に応じて追加
        "lookupResolution": [],      # 必要に応じて追加
        "multiChoiceColumns": [],    # 必要に応じて追加
    }

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f"✅ {output_path}")
    print(f"   通常列: {len(fields)}")
    print(f"   データ件数: {len(items)}")
    print(f"   ヘッダ: {header}")
    print()
    print("💡 次のステップ:")
    print("   1. 出力JSONを編集して、必要なら lookupFields/lookupResolution/itemColumnMapping を追加")
    print("   2. PnPスクリプトで実行:")
    print(f"      pwsh -File ./create_list_from_schema.ps1 -SchemaPath {output_path}")


if __name__ == "__main__":
    main()
