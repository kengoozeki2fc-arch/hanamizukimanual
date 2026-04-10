# スクリーンショット撮影リスト

本マニュアルで使用している画像のファイル名一覧です。現状は全てプレースホルダ（点線ボックス）表示になっています。実際の画面を PNG で撮影し、同じファイル名で `images/` 直下に保存すると自動的に表示されます。

## 推奨設定

- **ブラウザ**：Google Chrome
- **ウィンドウサイズ**：1280×800 以上
- **形式**：PNG（透過不要）
- **ファイル名**：ASCII英数字のみ（下記リスト参照）
- **サイズ目安**：横幅 1000〜1400px、縦はコンテンツに応じて

## 撮影リスト

### 共通
| ファイル名 | 画面 | 撮影方法 |
|---|---|---|
| `vendor-invite-mail.png` | 取引先招待メール | Outlookで受信メールをスクショ or HTMLメール画面 |
| `vendor-login-otp.png` | 取引先ログイン：OTP入力 | `/login` を開きOTP送信後の状態 |
| `admin-login-step1.png` | 管理者ログイン：メール＋パスワード | `/admin/login` を開いた初期状態 |
| `admin-login-step2.png` | 管理者ログイン：OTP入力 | 「次へ」クリック後のOTP入力状態 |

### 取引先
| ファイル名 | 画面 |
|---|---|
| `vendor-register.png` | 業者登録フォーム（初回ログイン後） |
| `vendor-invoice-top.png` | 請求書登録画面 |
| `vendor-invoice-success.png` | 請求書提出完了画面 |
| `vendor-inquiry.png` | お問い合わせ画面 |
| `vendor-change-contact.png` | 担当者変更画面 |

### 所長
| ファイル名 | 画面 |
|---|---|
| `shocho-invoice-list.png` | 請求書一覧（所長ログインで） |
| `shocho-invoice-detail.png` | 請求書詳細画面（明細入力エリア表示） |
| `shocho-reject-comment.png` | 所長否認：否認理由入力エリア |
| `shocho-approvals.png` | 月別承認進捗：所長ビュー |

### 部門管理者
| ファイル名 | 画面 |
|---|---|
| `dept-approvals-list.png` | 月別承認進捗：部長ビュー |
| `dept-approval-detail.png` | 承認詳細画面：部門管理者操作パネル |
| `dept-reject.png` | 部長否認：否認理由入力 |

### 役員
| ファイル名 | 画面 |
|---|---|
| `exec-approvals-list.png` | 月別承認進捗：役員ビュー |
| `exec-approval-detail.png` | 承認詳細画面：役員操作パネル |

### 総務管理者
| ファイル名 | 画面 |
|---|---|
| `somu-vendor-invite.png` | 取引先招待画面 |
| `somu-vendors.png` | 取引先管理一覧 |
| `somu-receiving.png` | 現場設定画面 |
| `somu-tax-categories.png` | 工種マスタ画面 |
| `somu-tax-rates.png` | 消費税率マスタ画面 |
| `somu-inquiries.png` | お問い合わせ一覧画面 |

### システム管理者
| ファイル名 | 画面 |
|---|---|
| `sys-users.png` | ユーザ管理画面 |
| `sys-reset-pw.png` | パスワードリセットモーダル |
| `sys-dept-exec.png` | 部門管理者・役員設定画面 |

## 撮影後の作業

1. 上記のファイル名で `/Users/kengoozeki/Documents/GitHub/hanamizukimanual/kensetsu-invoice/images/` に配置
2. `git add images/*.png && git commit -m "docs(kensetsu-invoice): スクリーンショット追加"`
3. `git push` で SWA に自動デプロイ
4. `https://manual.kensetsu-total.support/kensetsu-invoice/` で表示確認
