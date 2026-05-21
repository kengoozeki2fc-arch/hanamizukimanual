# 1kg-001 一級学科 R7本試験 全72問演習サイト

## 構成
- `index.html` — 公開HTML（8110行・`_gen.py` から生成）
- `_gen.py` — Pythonジェネレータ（問題データ+テンプレ展開）
- `figs/` — 図問題4問+No.2照度図の300dpi PNG（最大幅2000px）

## 再生成
```bash
cd ~/Source/hanamizukimanual
python3 oisi/benkyokai/1kg-001/_gen.py
```

## 試験仕様
- 令和7年(2025)7月20日(日) 1級建築施工管理技術検定 第一次検定
- 全72問・60問解答・60点満点・各1点
- 出題分野＝建築学①(1-6)/建築学②(7-15 9中6)/設備契約(16-20)/躯体(21-30 10中8)/仕上(31-40 10中7)/施工計画(41-44)/品質安全(45-50)/応用能力5択(51-60)/法規(61-72 12中8)
- 出典: 一般財団法人 建設業振興基金 公表問題 `r07_1kg_mondai.pdf`+`2507r07_ans1k.pdf`

## 特記
- **No.57 = 試験実施機関訂正で正解3または4どちらも正答**として採点（`data-answer="3" data-answer-alt="4"`、JS gradeOne拡張）
- No.5/7/11/12（図問題）と No.2（照度計算図）は PDFから抽出して `figs/q{N}.png` で埋込・**クリックでライトボックス全画面拡大**
- 5択（No.51-60）は choices配列が5要素になるだけで render_card が自動対応

## 次年度追加方法（1kg-002 = 令和6年 等）
1. `~/Source/hanamizukimanual/oisi/benkyokai/1kg-001/` を `1kg-002/` にコピー
2. `_gen.py` の `Q = []` を令和6年の72問データに差し替え
3. `figs/` の図画像を差し替え（必要があれば）
4. `STORAGE_KEY` を `benkyokai-1kg-r06-state-v1` 等に変更
5. `python3 oisi/benkyokai/1kg-002/_gen.py` で生成
6. `oisi/benkyokai/index.html` の学習コーナーセクションに `1kg-002/` リンク追加
7. git push → SWAデプロイ

## 関連メモリ
- `project_ooishi_benkyokai_1kg_001.md`（MyBrain）
- `feedback_lightbox_html_before_script.md`（MyBrain）— ライトボックスHTMLは `<script>` より前に置く罠
