# ZMK Firmware Debug Webpage 要件定義書 (Requirements)

## 1. プロジェクト概要
ユーザーが自作キーボード（ZMKファームウェア使用）の設定ファイルフォルダをアップロードし、その内容を解析してキーボード配列を可視化・不具合診断を行うWebツール。
元々は「ZaruBall」専用であったが、任意のZMK構成フォルダに対応するように汎用化する。

## 2. システムの目的
任意のZMKファームウェア構成フォルダを読み込み、物理配列と配線マトリクスを動的に再構築する。
これにより、特定のキーボードに限らず、ZMKを使用する多様な自作キーボードの組み立て時不具合（ハンダ不良、ピン断線など）のトラブルシューティングを支援する。

## 3. 機能要件

### 3.1 フォルダ読み込み機能
- ユーザーはローカルのファームウェア構成フォルダ（通常は `config` や `boards/shields/<shield_name>` を含むフォルダ）を選択してアップロードできる (`<input type="file" webkitdirectory>`).
- システムはフォルダ内の `.dtsi`, `.overlay`, `.keymap` (オプション) 等の関連ファイルを検索・読み込みする。

### 3.2 ファームウェア解析機能 (Parser)
読み込んだテキストファイル群から以下の情報を抽出する。
- **Physical Layout (`physical_layout` node)**:
    - キーの物理座標 (x, y)、サイズ (w, h)、回転 (r, rx, ry)。
    - `<&key_physical_attrs ...>` 形式のデータを解析。
- **Matrix Transform (`default_transform` node)**:
    - 論理マトリクス(`row`, `col`)と物理キーの対応関係。
    - `RC(row, col)` マクロの解析。
    - `col-offset`, `row-offset` の処理（分割キーボード対応）。
- **Kscan / Pin Config (`kscan` node)**:
    - 使用されているマイコンのピン番号 (`row-gpios`, `col-gpios`)。
    - `&xiao_d`, `&gpio0` などの参照を解決（可能な範囲で）。
    - 左右キーボード（`.overlay`）ごとのピン割り当ての違いを考慮。

### 3.3 キーボード配列の可視化
- 解析された `Physical Layout` データに基づき、Canvas上にキーボードを描画する。
- 左右分割キーボードの場合、適切に並べて表示する。

### 3.4 不具合診断機能
- **動的診断ロジック**:
    - 解析されたマトリクスサイズ（Rows x Cols）に基づいて診断ロジックを構築する。
    - 列単位、行単位の同時選択を検知し、対応する `row-gpios` / `col-gpios` のピン番号を指摘する。

## 4. データ構造定義 (Dynamic)

### 4.1 内部データモデル
```json
{
  "physicalKeys": [
    { "x": 0, "y": 0, "w": 1, "h": 1, "r": 0, "rx": 0, "ry": 0, "matrixIndex": 0 }
  ],
  "matrixMap": [
    { "row": 0, "col": 0 } // index corresponds to physicalKeys order ?? Or mapped via matrix-transform
  ],
  "pins": {
    "left": { "rows": [...], "cols": [...] },
    "right": { "rows": [...], "cols": [...] }
  }
}
```

## 5. UI/UX デザイン方針
- **ファイル選択エリア**: 初回アクセス時に目立つように配置。「フォルダを選択してください」と案内。
- **解析ステータス**: 読み込み・解析の成功/失敗をユーザーに通知。
- **デバッグ画面**: 解析成功後、既存のデバッグUIを表示。
