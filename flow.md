# System Flow Diagram

このドキュメントは、Generic ZMK Debugger の動作フローを説明するものです。

## 1. 全体ワークフロー

```mermaid
graph TD
    A[ユーザー] -->|GitHubリポジトリ入力| B[GitHubFetcher]
    B -->|ファイル取得 .dtsi, .overlay, .conf| C[ZMKParser]
    C -->|1. コメント削除| D[正規化テキスト]
    D -->|2. build.yaml解析| E[サイド判定・シールド特定]
    E -->|3. chosenノード解析| F[ターゲットレイアウト特定]
    F -->|4. Physical Layout解析| G[物理座標データ]
    G -->|5. Matrix Transform解析| H[論理/物理マトリクス対応表]
    H -->|6. Pin Config解析| I[GPIOピン割り当てマップ]
    I --> J[解析完了・UI表示]
    J --> K[キャンバス描画]
    K --> L[ユーザーがキーを選択]
    L --> M[診断ロジック実行]
    M --> N[診断結果表示]
```

## 2. 解析ロジックの詳細 (ZMKParser)

```mermaid
flowchart LR
    subgraph Files["Raw Files (.dtsi, .overlay)"]
        direction TB
        F1[Base .dtsi]
        F2[Left .overlay]
        F3[Right .overlay]
    end

    Files --> Strip["stripComments()"]
    Strip --> PL["findAndParsePhysicalLayout()<br/>chosenノード優先"]
    Strip --> MT["findAndParseMatrixTransform()<br/>col-offsetの考慮"]
    Strip --> PC["findAndParsePinConfig()<br/>左右・共通ピンのマージ"]

    subgraph Data["Parsed Data Structure"]
        physicalKeys["physicalKeys: [x, y, w, h, r]"]
        matrixMap["matrixMap: [row, col]"]
        pinMap["pinMap: {left, right}"]
    end

    PL --> physicalKeys
    MT --> matrixMap
    PC --> pinMap
```

## 3. 診断ロジック (analyzeFailures)

```mermaid
graph TD
    Start[診断ボタン押下] --> Select[選択されたキーの取得]
    Select --> Side[サイド判定: offsetに基づき分離]
    Side --> Group[物理行・物理列ごとにグループ化]
    
    subgraph Analysis["解析アルゴリズム"]
        direction TB
        Type{配線方式?}
        
        Type -->|Standard Matrix| SLogic["行/列ごとの選択率 > 60% で不具合判定"]
        Type -->|Charlieplex| CLogic["各ピンの役割(In/Out)別に不具合率を計算"]
        
        SLogic --> S_Res["行/列/個別スイッチの不具合を表示"]
        
        CLogic --> CRole{失敗パターンの分類}
        CRole -->|Input側のみ| C_In["原因: Line/Int Diode または マイコンピン"]
        CRole -->|Output側のみ| C_Out["原因: マイコンピン (ダイオードは無関係)"]
        CRole -->|双方| C_Both["原因: マイコンピン自体の接続不良"]
    end
    
    Group --> Analysis
    Analysis --> Display["結果表示: インデックス・ピン・推定原因を表示"]
```

## 4. 特殊な配線方式とダイオードの処理

### 分割キーボード
*   `col-offset` または `row-offset` を超過している場合、「Right Side」として判定。
*   物理的な配線特定のため、オフセットを差し引いた物理座標を使用してピンマップを参照。

### Charlieplex 解析
*   **構造**: 各ピンは「信号受信用 (Input/Row)」と「信号送信用 (Output/Col)」の双方の役割を異なるタイミングで担います。
*   **判定**: ピン単体の動作ではなく、「Inputとしての挙動」と「Outputとしての挙動」を個別に蓄積・解析します。
*   **不具合の分類**:
    1.  **Input側のみ不具合**: そのピンをRowとして使うキーのみ反応しない。
        *   原因: **Line/Int Diode** または マイコンピンの不具合。
    2.  **Output側のみ不具合**: そのピンをColとして使うキーのみ反応しない。
        *   原因: **マイコンピン**の不具合（ダイオードは無関係）。
    3.  **双方で不具合**: そのピンに関わる全てのキーが反応しない。
        *   原因: **マイコンピン自体の接続不良**（半田浮き等）。

### ダイオード不具合の条件
*   **原則**: Line Diode および Int Diode は **Charlieplex 配線方式においてのみ**使用される部品です。
*   **反映**: 通常マトリクスでは無視し、Charlieplex において「Input側の動作不良」が検知された場合のみ、診断結果に候補として表示します。

