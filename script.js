/**
 * ZMK Debugger Script
 * Parses ZMK configuration files from GitHub to build a debug interface.
 */

// --- Constants ---
const U = 60; // Render unit size in pixels
const SCALE = 0.6; // Scale factor

// --- State ---
let parsedData = {
    physicalKeys: [],
    matrixMap: [],
    pinMap: { left: {}, right: {} },
    matrixTransform: { rows: 0, cols: 0 },
    database: null // Loaded database.json
};

const state = {
    selectedIndices: new Set()
};

let themeColors = {};

// --- Theme ---
function updateThemeColors() {
    const style = getComputedStyle(document.body);
    themeColors = {
        keyDefault: style.getPropertyValue('--key-default').trim(),
        keySelected: style.getPropertyValue('--key-selected').trim(),
        keyStroke: style.getPropertyValue('--key-stroke').trim(),
        keySelectedStroke: style.getPropertyValue('--key-selected-stroke').trim()
    };
}

// --- Main Init ---
document.addEventListener('DOMContentLoaded', () => {
    updateThemeColors();

    // UI Elements
    const loadBtn = document.getElementById('loadBtn');
    const repoInput = document.getElementById('repoInput');
    const resetBtn = document.getElementById('resetBtn');
    const diagnoseBtn = document.getElementById('diagnoseBtn');
    const dlTemplateBtn = document.getElementById('dlTemplateBtn');

    // Event Listeners
    loadBtn.addEventListener('click', handleRepoLoad);
    resetBtn.addEventListener('click', resetSelection);
    diagnoseBtn.addEventListener('click', diagnose);
    dlTemplateBtn.addEventListener('click', downloadTemplate);

    // Add Enter key support for input
    repoInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleRepoLoad();
    });
});


// --- GitHub Fetcher ---

async function handleRepoLoad() {
    const repoInput = document.getElementById('repoInput');
    const statusMsg = document.getElementById('statusMessage');
    const repo = repoInput.value.trim();

    if (!repo) {
        setStatus("リポジトリ名を入力してください。", "error");
        return;
    }

    setStatus("ファイルリストを取得中...", "loading");

    try {
        const fetcher = new GitHubFetcher(repo);
        const filesData = await fetcher.fetchRelevantFiles();

        if (Object.keys(filesData).length === 0) {
            throw new Error("関連ファイル (.dtsi, .overlay, .conf) が見つかりませんでした。");
        }

        setStatus("解析中...", "loading");

        const parser = new ZMKParser();
        parser.parse(filesData);
        parsedData = parser.getResult();

        if (parsedData.physicalKeys.length === 0) {
            throw new Error("キー配置データ(Physical Layout)が見つかりませんでした。");
        }

        // Init UI
        setStatus("解析完了", "success");
        // Try to fetch database.json
        setStatus("データベース検索中...", "loading");
        try {
            parsedData.database = await fetcher.fetchDatabase();
            if (parsedData.database) {
                console.log("Database loaded successfully.");
                document.getElementById('dlTemplateBtn').classList.add('hidden');
            } else {
                console.warn("Database not found.");
                document.getElementById('dlTemplateBtn').classList.remove('hidden');
            }
        } catch (e) {
            console.warn("Database fetch failed", e);
            document.getElementById('dlTemplateBtn').classList.remove('hidden');
        }

        // Init UI
        setStatus("解析完了", "success");
        document.getElementById('debugInterface').classList.remove('hidden');
        initCanvas();

    } catch (err) {
        console.error(err);
        setStatus(`エラー: ${err.message}`, "error");
        document.getElementById('debugInterface').classList.add('hidden');
    }
}

function setStatus(msg, type) {
    const el = document.getElementById('statusMessage');
    el.textContent = msg;
    el.className = `status-message ${type}`;
}

class GitHubFetcher {
    constructor(repoStr) {
        // Robust parsing for various GitHub URL formats
        // Supported:
        // - user/repo
        // - https://github.com/user/repo
        // - https://github.com/user/repo/tree/branch-name
        // - user/repo.git

        let cleaned = repoStr.trim();
        cleaned = cleaned.replace(/^https?:\/\/github\.com\//, '');
        cleaned = cleaned.replace(/\.git$/, '');

        this.branch = null;

        // Check for /tree/ segment
        if (cleaned.includes('/tree/')) {
            const parts = cleaned.split('/tree/');
            // parts[0] is "user/repo", parts[1] is "branch/path..."
            this.repo = parts[0];
            // Take the first segment after tree as branch (simple assumption)
            // If branch has slashes, this might need more robust logic, but usually it's correct for URL from browser
            // Actually, usually URL is .../tree/branchname/folder
            // Let's assume everything after /tree/ is the branch or we treat it as ref
            // But wait, if they paste "tree/main/config", we want branch="main", and search path relative to root?
            // For now, let's treat the part after tree/ as the branch REF.
            this.branch = parts[1].split('/')[0];
            console.log(`Detected Branch: ${this.branch}`);
        } else {
            const parts = cleaned.split('/').filter(p => p.length > 0);
            if (parts.length >= 2) {
                this.repo = `${parts[0]}/${parts[1]}`;
            } else {
                this.repo = cleaned;
            }
        }

        console.log(`Parsed Repo: '${this.repo}', Branch: '${this.branch || 'default'}'`);

        this.baseUrl = `https://api.github.com/repos/${this.repo}/contents`;
    }

    async fetchRelevantFiles() {
        // Strategy:
        // 1. Get default branch if not specified.
        // 2. Get recursive tree of the repo.
        // 3. Filter for relevant files (.dtsi, .overlay, .keymap, .conf).
        // 4. Fetch content for each file using API or raw URL.

        if (!this.branch) {
            this.branch = await this.getDefaultBranch();
            console.log(`Using default branch: ${this.branch}`);
        }

        const tree = await this.getRecursiveTree(this.branch);
        console.log(`Found ${tree.length} files in tree.`);

        const relevantFiles = tree.filter(f =>
            f.type === 'blob' && (
                f.path.endsWith('.dtsi') ||
                f.path.endsWith('.overlay') ||
                f.path.endsWith('.keymap') ||
                f.path.endsWith('.conf') ||
                f.path.endsWith('build.yaml')
            )
        );

        console.log(`Relevant files found: ${relevantFiles.length}`);

        const filesData = {};
        for (const f of relevantFiles) {
            const url = `https://raw.githubusercontent.com/${this.repo}/${this.branch}/${f.path}`;
            try {
                // Determine file name from path (e.g. "boards/shields/foo/foo.dtsi" -> "foo.dtsi")
                // Or keep full path? The parser uses filenames to log. Let's keep full path or just filename.
                // Keeping full path might be better for uniqueness but parser usually expects flat map or uses filename for logging.
                // Let's use the full path as key to avoid collisions, but log just filename if needed.
                filesData[f.path] = await this.fetchContent(url);
                console.log(`Fetched: ${f.path}`);
            } catch (e) {
                console.warn(`Failed to fetch ${f.path}:`, e);
            }
        }

        return filesData;
    }

    async getDefaultBranch() {
        const url = `https://api.github.com/repos/${this.repo}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error("Failed to fetch repo info");
        const data = await res.json();
        return data.default_branch;
    }

    async getRecursiveTree(sha) {
        const url = `https://api.github.com/repos/${this.repo}/git/trees/${sha}?recursive=1`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Failed to fetch tree: ${res.statusText}`);
        const data = await res.json();
        return data.tree; // Array of objects
    }

    async fetchContent(url) {
        // For private repos, raw.githubusercontent with token header works if token is valid for the repo.
        // But browser fetch to raw.githubusercontent might fail with CORS if no token?
        // Actually raw.githubusercontent.com supports CORS but private repos need token.
        // If user provided token (removed in this version), it would work.
        // Without token, public repos work fine.
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Failed to fetch content: ${url}`);
        return await res.text();
    }

    async fetchDatabase() {
        // Try fetching database.json from root
        // If branch is set, use it.
        const url = `https://raw.githubusercontent.com/${this.repo}/${this.branch || 'main'}/database.json`;
        try {
            // We use fetch directly. If 404, it throws or returns !ok
            const res = await fetch(url);
            if (res.ok) {
                return await res.json();
            }
        } catch (e) {
            console.log("database.json check failed:", e);
        }
        return null;
    }
}


// --- ZMK Parser ---

class ZMKParser {
    constructor() {
        this.result = {
            physicalKeys: [], // {x, y, w, h, r, rx, ry}
            matrixMap: [], // {r, c}
            pinMap: { left: { row: {}, col: {} }, right: { row: {}, col: {} } },
            matrixTransform: { rows: 0, cols: 0, colOffset: 0, rowOffset: 0 }
        };
        this.rawFiles = {};
    }

    getResult() {
        return this.result;
    }

    parse(filesData) {
        this.rawFiles = filesData;

        // 1. Parse Pre-processing (remove comments)
        for (const [name, content] of Object.entries(this.rawFiles)) {
            this.rawFiles[name] = this.stripComments(content);
        }

        // 2. Parse Build Config (for split side detection)
        this.findAndParseBuildConfig();

        // 3. Parse Physical Layout
        this.findAndParsePhysicalLayout();

        // 4. Parse Matrix Transform
        this.findAndParseMatrixTransform();

        // 5. Parse Pin Config
        this.findAndParsePinConfig();
    }

    findAndParseBuildConfig() {
        this.shields = { left: null, right: null };
        // Look for build.yaml
        for (const [name, content] of Object.entries(this.rawFiles)) {
            if (name.endsWith('build.yaml')) {
                console.log(`Found build.yaml: ${name}`);
                // Simple parsing for "shield: <name>"
                // Example: shield: mona2_r rgbled_adapter
                const lines = content.split('\n');
                for (const line of lines) {
                    const match = line.match(/shield:\s*([^\s]+)/); // Take first token after shield:
                    if (match) {
                        const shieldName = match[1];
                        if (shieldName === 'settings_reset') continue;

                        if (shieldName.endsWith('_l')) {
                            this.shields.left = shieldName;
                            console.log(`Identified Left Shield: ${shieldName}`);
                        } else if (shieldName.endsWith('_r')) {
                            this.shields.right = shieldName;
                            console.log(`Identified Right Shield: ${shieldName}`);
                        }
                    }
                }
            }
        }
    }

    stripComments(text) {
        return text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    }

    findAndParsePhysicalLayout() {
        // Strategy A: Check "chosen" node
        let targetLabel = null;
        const chosenRegex = /zmk,physical-layout\s*=\s*&([\w-]+);/;

        for (const content of Object.values(this.rawFiles)) {
            const match = chosenRegex.exec(content);
            if (match) {
                targetLabel = match[1];
                console.log(`Found chosen physical layout label: ${targetLabel}`);
                break;
            }
        }

        const genericLayoutRegex = /keys\s*=\s*<([\s\S]*?)>;/;
        // Improved key regex to handle various spacing and optional format
        // Supports: &key_physical_attrs w h x y r rx ry
        // Supports: &key_physical_attrs w h x y (ignores rest if 0 0 0 or similar)
        const keyAttrsRegex = /&key_physical_attrs\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(?:(\(-?\d+\)|-?\d+)\s+(\d+)\s+(\d+)|0\s+0\s+0)/g;

        // Pass 1: Try explicit target label
        if (targetLabel) {
            for (const [filename, content] of Object.entries(this.rawFiles)) {
                // Find node definition: "label: node {"
                const labelRegex = new RegExp(`${targetLabel}\\s*:\\s*[\\w-]+\\s*\\{`);
                const labelMatch = labelRegex.exec(content);

                if (labelMatch) {
                    console.log(`Found target layout node in ${filename}`);
                    const layoutContentToParse = content.substring(labelMatch.index);
                    if (this.parseKeysFromContent(layoutContentToParse, genericLayoutRegex, keyAttrsRegex)) {
                        return;
                    }
                }
            }
        }

        // Pass 2: Fallback - Look for any node with compatible = "zmk,physical-layout"
        console.log("Pass 1 failed or no chosen label. Trying fallback strategy (compatible string)...");
        const compatibleRegex = /compatible\s*=\s*"zmk,physical-layout"/;

        for (const [filename, content] of Object.entries(this.rawFiles)) {
            const match = compatibleRegex.exec(content);
            if (match) {
                console.log(`Found compatible physical layout in ${filename}`);
                // Start parsing from the match index (approximate node start)
                // We assume keys property is nearby (after compatible)
                const layoutContentToParse = content.substring(match.index);
                if (this.parseKeysFromContent(layoutContentToParse, genericLayoutRegex, keyAttrsRegex)) {
                    return;
                }
            }
        }
    }

    parseKeysFromContent(content, layoutRegex, keyAttrsRegex) {
        const match = layoutRegex.exec(content);
        if (match) {
            const keysBlock = match[1];
            let keyMatch;
            let count = 0;
            while ((keyMatch = keyAttrsRegex.exec(keysBlock)) !== null) {
                let r = 0;
                if (keyMatch[5]) {
                    const rawR = keyMatch[5].replace(/[()]/g, '');
                    // If rawR is "0", parseInt is 0.
                    r = parseInt(rawR) / 100;
                }

                const k = {
                    w: parseInt(keyMatch[1]) / 100,
                    h: parseInt(keyMatch[2]) / 100,
                    x: parseInt(keyMatch[3]) / 100,
                    y: parseInt(keyMatch[4]) / 100,
                    r: r,
                    rx: keyMatch[6] ? parseInt(keyMatch[6]) / 100 : 0,
                    ry: keyMatch[7] ? parseInt(keyMatch[7]) / 100 : 0
                };
                this.result.physicalKeys.push(k);
                count++;
            }

            if (count > 0) {
                console.log(`Parsed ${count} keys.`);
                return true;
            }
        }
        return false;
    }

    findAndParseMatrixTransform() {
        const rcRegex = /RC\(\s*(\d+)\s*,\s*(\d+)\s*\)/g;
        const colOffsetRegex = /col-offset\s*=\s*<(\d+)>/;

        for (const [filename, content] of Object.entries(this.rawFiles)) {
            // Transform Map
            if (content.includes('map = <')) {
                const mapBlockMatch = /map\s*=\s*<([\s\S]*?)>;/.exec(content);
                if (mapBlockMatch) {
                    // Check if this map is the one used? Ideally check chosen zmk,matrix-transform
                    // But usually there's only one main map in use or they are similar
                    let match;
                    const map = [];
                    while ((match = rcRegex.exec(mapBlockMatch[1])) !== null) {
                        map.push({
                            r: parseInt(match[1]),
                            c: parseInt(match[2])
                        });
                    }
                    if (map.length > this.result.matrixMap.length) {
                        this.result.matrixMap = map;
                        console.log(`Found Matrix Map in ${filename}: ${map.length} entries`);
                    }
                }
            }

            // Col Offset
            if (content.includes('col-offset')) {
                const match = colOffsetRegex.exec(content);
                if (match) {
                    // Heuristic or precise check for right side overlay to get offset
                    let isRight = filename.includes('right');
                    if (this.shields && this.shields.right && filename.includes(this.shields.right)) {
                        isRight = true;
                    }

                    if (isRight) {
                        this.result.matrixTransform.colOffset = parseInt(match[1]);
                        console.log(`Found Col Offset ${this.result.matrixTransform.colOffset} in ${filename}`);
                    }
                }
            }

            // Row Offset
            if (content.includes('row-offset')) {
                const match = /row-offset\s*=\s*<(\d+)>/.exec(content);
                if (match) {
                    let isRight = filename.includes('right');
                    if (this.shields && this.shields.right && filename.includes(this.shields.right)) {
                        isRight = true;
                    }
                    if (isRight) {
                        this.result.matrixTransform.rowOffset = parseInt(match[1]);
                        console.log(`Found Row Offset ${this.result.matrixTransform.rowOffset} in ${filename}`);
                    }
                }
            }
        }
    }

    findAndParsePinConfig() {
        for (const [filename, content] of Object.entries(this.rawFiles)) {
            // Check for kscan node
            // Standard or Charlieplex
            // We search for nodes that have row-gpios/col-gpios OR gpios/interrupt-gpios

            // Heuristic to decide side
            let side = 'left';
            if (filename.includes('right')) side = 'right';

            // Precise detection using shields from build.yaml
            if (this.shields && this.shields.left && filename.includes(this.shields.left)) {
                side = 'left';
            } else if (this.shields && this.shields.right && filename.includes(this.shields.right)) {
                side = 'right';
            }

            // Standard Matrix
            if (content.includes('row-gpios') || content.includes('col-gpios')) {
                const rowGpios = this.extractGpioList(content, 'row-gpios');
                const colGpios = this.extractGpioList(content, 'col-gpios');

                if (Object.keys(rowGpios).length > 0) this.result.pinMap[side].row = rowGpios;
                if (Object.keys(colGpios).length > 0) this.result.pinMap[side].col = colGpios;
                console.log(`Parsed Standard Pins for ${side} (${filename})`);
            }

            // Charlieplex
            // Looks for gpios = <...>; and maybe interrupt-gpios
            if (content.includes('compatible') && content.includes('zmk,kscan-gpio-charlieplex') || (content.includes('gpios') && !content.includes('row-gpios') && !content.includes('col-gpios'))) {
                // Parse 'gpios'
                const gpios = this.extractGpioList(content, 'gpios');
                // Parse 'interrupt-gpios' (usually just one)
                const intGpios = this.extractGpioList(content, 'interrupt-gpios');

                if (Object.keys(gpios).length > 0) {
                    this.result.pinMap[side].gpios = gpios;
                    console.log(`Parsed Charlieplex Pins for ${side}:`, gpios);
                }
                if (Object.keys(intGpios).length > 0) {
                    // Just take the first one
                    this.result.pinMap[side].interrupt = intGpios[0];
                    console.log(`Parsed Interrupt Pin for ${side}:`, intGpios[0]);
                }
            }
        }
    }

    extractGpioList(content, propName) {
        // Regex to match "propName = < ... >;" (multiline)
        const regex = new RegExp(`${propName}\\s*=\\s*<([\\s\\S]*?)>;`);
        const match = regex.exec(content);
        if (!match) return {};

        const inner = match[1];
        const pins = {};
        let idx = 0;

        const tokens = inner.split(/[\s,<>]+/).filter(t => t.length > 0);

        for (let i = 0; i < tokens.length; i++) {
            if (tokens[i].startsWith('&')) {
                const phandle = tokens[i];
                const pinNum = tokens[i + 1];
                // Skip flags tokens[i+2] etc...

                let readable = `${phandle} ${pinNum}`;
                readable = readable.replace('&', '');

                // Removed simplification logic to keep raw names like "xiao_d 0"

                // For interrupt-gpios, there might be parens in flags like (GPIO_ACTIVE_HIGH | ...)?
                // Our simple split might split keys. 
                // But we act only on tokens starting with &.

                pins[idx] = readable;
                idx++;
            }
        }

        return pins;
    }
}


// --- Canvas & Rendering ---

const canvas = document.getElementById('keyboardCanvas');
const ctx = canvas.getContext('2d');

function initCanvas() {
    if (parsedData.physicalKeys.length === 0) return;

    let maxX = 0;
    let maxY = 0;
    parsedData.physicalKeys.forEach(k => {
        const x = k.x + (k.w || 1);
        const y = k.y + (k.h || 1);
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
    });

    canvas.width = (maxX + 1) * U * SCALE;
    canvas.height = (maxY + 1) * U * SCALE;

    draw();
}

function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.scale(SCALE, SCALE);

    parsedData.physicalKeys.forEach((key, index) => {
        drawKey(key, index, state.selectedIndices.has(index));
    });

    ctx.restore();
}

function drawKey(key, index, isSelected) {
    const x = key.x * U;
    const y = key.y * U;
    const w = (key.w || 1) * U;
    const h = (key.h || 1) * U;

    ctx.save();

    if (key.r) {
        const cx = key.rx * U;
        const cy = key.ry * U;
        ctx.translate(cx, cy);
        ctx.rotate(key.r * Math.PI / 180);
        ctx.translate(-cx, -cy);
    }

    ctx.fillStyle = isSelected ? themeColors.keySelected : themeColors.keyDefault;
    ctx.strokeStyle = isSelected ? themeColors.keySelectedStroke : themeColors.keyStroke;
    ctx.lineWidth = 2;

    roundRect(ctx, x, y, w, h, 8);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = isSelected ? '#7f1d1d' : '#475569';
    ctx.font = '10px Inter';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const m = parsedData.matrixMap[index];
    if (m) {
        ctx.fillText(`${m.r}, ${m.c}`, x + w / 2, y + h / 2);
    }

    ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
    if (w < 2 * r) r = w / 2;
    if (h < 2 * r) r = h / 2;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}


// --- Interaction ---

function getKeyAt(screenX, screenY) {
    for (let i = 0; i < parsedData.physicalKeys.length; i++) {
        const k = parsedData.physicalKeys[i];

        let tx = screenX;
        let ty = screenY;

        if (k.r) {
            const cx = k.rx * U;
            const cy = k.ry * U;
            let dx = tx - cx;
            let dy = ty - cy;
            const rad = -k.r * Math.PI / 180;
            const cos = Math.cos(rad);
            const sin = Math.sin(rad);
            tx = dx * cos - dy * sin + cx;
            ty = dx * sin + dy * cos + cy;
        }

        const kx = k.x * U;
        const ky = k.y * U;
        const kw = (k.w || 1) * U;
        const kh = (k.h || 1) * U;

        if (tx >= kx && tx <= kx + kw && ty >= ky && ty <= ky + kh) {
            return i;
        }
    }
    return -1;
}

canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const xx = e.clientX - rect.left;
    const yy = e.clientY - rect.top;

    const index = getKeyAt(xx / SCALE, yy / SCALE);
    if (index !== -1) {
        if (state.selectedIndices.has(index)) {
            state.selectedIndices.delete(index);
        } else {
            state.selectedIndices.add(index);
        }
        draw();
    }
});

function resetSelection() {
    state.selectedIndices.clear();
    draw();
    document.getElementById('resultArea').classList.add('hidden');
}


// --- Diagnostics ---

function diagnose() {
    const resultArea = document.getElementById('resultArea');
    const resultContent = document.getElementById('resultContent');
    resultContent.innerHTML = '';

    if (state.selectedIndices.size === 0) {
        resultArea.classList.add('hidden');
        return;
    }

    resultArea.classList.remove('hidden');

    const failures = analyzeFailures();
    const ul = document.createElement('ul');
    ul.className = 'diagnosis-list';

    for (const f of failures) {
        const li = document.createElement('li');
        let title = '';
        let desc = '';

        if (f.type === 'row') {
            const info = getPinInfo(f.side, f.pin);
            title = `行 (Row) 全体の不具合 - ${f.side} Side`;
            desc = `Row Index: ${f.row}<br>Pin: <strong>${info.silk} (${f.pin})</strong>`;
            if (info.line_diode) desc += `<br>Line Diode: <strong>${info.line_diode}</strong>`;
            if (info.interrupt_diode) desc += `<br>Int Diode: <strong>${info.interrupt_diode}</strong>`;
            desc += `<br>このRowの配線またはマイコンのピンを確認してください。`;
        } else if (f.type === 'col') {
            const info = getPinInfo(f.side, f.pin);
            title = `列 (Column) 全体の不具合 - ${f.side} Side`;
            desc = `Col Index: ${f.col}<br>Pin: <strong>${info.silk} (${f.pin})</strong>`;
            if (info.line_diode) desc += `<br>Line Diode: <strong>${info.line_diode}</strong>`;
            desc += `<br>このColumnの配線またはマイコンのピンを確認してください。`;
        } else if (f.type === 'charlie') {
            const info = getPinInfo(f.side, f.pin);
            title = `Charlieplex GPIO ピン不具合 - ${f.side} Side`;
            desc = `Logical Index: ${f.index}<br>Pin: <strong>${info.silk} (${f.pin})</strong>`;
            if (info.line_diode) desc += `<br>Line Diode: <strong>${info.line_diode}</strong>`;
            if (info.interrupt_diode) desc += `<br>Int Diode: <strong>${info.interrupt_diode}</strong>`;
            desc += `<br>このピンに関連する配線を確認してください。<br>(Row/Colとして複数のキーに関与しています)`;
        } else if (f.type === 'interrupt') {
            const info = getPinInfo(f.side, f.pin);
            title = `割り込み (Interrupt) GPIO 不具合 - ${f.side} Side`;
            desc = `Pin: <strong>${info.silk} (${f.pin})</strong>`;
            if (info.line_diode) desc += `<br>Line Diode: <strong>${info.line_diode}</strong>`; // Unlikely for interrupt pin but consistent
            desc += `<br>このピンが接続されていないと、全てのキー入力が反応しません。<br>半田付けや結線を確認してください。`;
        } else if (f.type === 'single') {
            // Single key failure
            // Look up in database.keys
            // We need to match f.row, f.col (matrix coords)
            // Or f.index (matrixMap index) - analyzeFailures should provide matrix coords
            const matrixR = f.r;
            const matrixC = f.c;
            const keyInfo = getKeyInfo(matrixR, matrixC);

            title = `個別キーの不具合 - ${f.side} Side`;
            if (keyInfo) {
                desc = `Switch: <strong>${keyInfo.silk_sw}</strong>`;
                if (keyInfo.silk_d) desc += `<br>Diode: <strong>${keyInfo.silk_d}</strong>`;
                desc += `<br>Matrix: ${matrixR}, ${matrixC}`;
            } else {
                desc = `Matrix: ${matrixR}, ${matrixC}<br>個別の接触不良の可能性`;
            }
            desc += `<br>ソケット、スイッチ、ダイオードを確認してください。`;
        }

        li.innerHTML = `<strong>${title}</strong><p>${desc}</p>`;
        ul.appendChild(li);
    }


    resultContent.appendChild(ul);
}



function getPinInfo(side, rawPinName) {
    const key = `${side === 'left' ? 'Left' : 'Right'}_${rawPinName}`;
    if (parsedData.database && parsedData.database.pins && parsedData.database.pins[key]) {
        return parsedData.database.pins[key];
    }
    // Fallback or raw
    if (parsedData.database && parsedData.database.pins && parsedData.database.pins[rawPinName]) {
        return parsedData.database.pins[rawPinName];
    }
    return { silk: rawPinName, line_diode: null, interrupt_diode: null };
}

function getKeyInfo(r, c) {
    if (parsedData.database && parsedData.database.keys) {
        // Find key with matching matrix [r, c]
        // Note: JSON arrays are objects, strict comparison might fail if not careful, but values are primitive nums
        const found = parsedData.database.keys.find(k => k.matrix[0] === r && k.matrix[1] === c);
        return found;
    }
    return null;
}

function generateDatabaseTemplate() {
    const db = {
        pins: {},
        keys: []
    };

    // 1. Populate Pins from pinMap
    // Iterate both sides
    ['left', 'right'].forEach(side => {
        const pm = parsedData.pinMap[side];
        if (!pm) return;

        // Standard
        if (pm.row) Object.values(pm.row).forEach(p => db.pins[`${side === 'left' ? 'Left' : 'Right'}_${p}`] = { silk: "M_?", line_diode: "D_?", interrupt_diode: "" });
        if (pm.col) Object.values(pm.col).forEach(p => db.pins[`${side === 'left' ? 'Left' : 'Right'}_${p}`] = { silk: "M_?", line_diode: "D_?", interrupt_diode: "" });

        // Charlieplex
        if (pm.gpios) Object.values(pm.gpios).forEach(p => {
            const key = `${side === 'left' ? 'Left' : 'Right'}_${p}`;
            // Avoid overwriting if existing
            if (!db.pins[key]) db.pins[key] = { silk: "M_?", line_diode: "D_?", interrupt_diode: "DI_?" };
        });
        if (pm.interrupt) {
            const p = pm.interrupt;
            const key = `${side === 'left' ? 'Left' : 'Right'}_${p}`;
            if (!db.pins[key]) db.pins[key] = { silk: "IGPIO", description: "Interrupt Pin" };
        }
    });

    // 2. Populate Keys
    // Iterate matrixMap
    parsedData.matrixMap.forEach((m, i) => {
        if (!m) return;
        db.keys.push({
            matrix: [m.r, m.c],
            silk_sw: `SW${i + 1}`,
            silk_d: `D${i + 1}`
        });
    });

    return JSON.stringify(db, null, 2);
}

function downloadTemplate() {
    const json = generateDatabaseTemplate();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'database.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}


function analyzeFailures() {
    const selected = Array.from(state.selectedIndices);
    const report = [];
    const colOffset = parsedData.matrixTransform.colOffset || 0;
    const rowOffset = parsedData.matrixTransform.rowOffset || 0;
    const groups = { left: { rows: {}, cols: {} }, right: { rows: {}, cols: {} } };
    const counts = { left: { rows: {}, cols: {} }, right: { rows: {}, cols: {} } };

    // Charlieplex specific counts
    // Logical indices map to gpios list.
    // If gpios array is [P0, P1, P2...], then row 0 means P0, col 0 means P0.
    // We will count failure usage per logical index.

    const charlieCounts = { left: {}, right: {} };
    const charlieTotals = { left: {}, right: {} };
    // charlieCounts[side][logicalIndex] = number of selected keys using this index

    // Count totals first
    parsedData.matrixMap.forEach((m, idx) => {
        if (!m) return;

        // Determine side based on offset
        let side = 'left';
        let physCol = m.c;
        let physRow = m.r;

        if (colOffset > 0 && m.c >= colOffset) {
            side = 'right';
            physCol = m.c - colOffset;
        } else if (rowOffset > 0 && m.r >= rowOffset) {
            side = 'right';
            physRow = m.r - rowOffset;
        }

        // Standard
        if (!counts[side].rows[physRow]) counts[side].rows[physRow] = 0;
        counts[side].rows[physRow]++;

        if (!counts[side].cols[physCol]) counts[side].cols[physCol] = 0;
        counts[side].cols[physCol]++;

        // Charlieplex totals
        if (parsedData.pinMap[side].gpios) {
            if (!charlieTotals[side][physRow]) charlieTotals[side][physRow] = 0;
            charlieTotals[side][physRow]++;

            if (!charlieTotals[side][physCol]) charlieTotals[side][physCol] = 0;
            charlieTotals[side][physCol]++;
        }
    });

    // Group selected
    selected.forEach(idx => {
        const m = parsedData.matrixMap[idx];
        if (!m) return;

        let side = 'left';
        let physCol = m.c;
        let physRow = m.r;

        if (colOffset > 0 && m.c >= colOffset) {
            side = 'right';
            physCol = m.c - colOffset;
        } else if (rowOffset > 0 && m.r >= rowOffset) {
            side = 'right';
            physRow = m.r - rowOffset;
        }

        if (!groups[side].rows[physRow]) groups[side].rows[physRow] = [];
        groups[side].rows[physRow].push(idx);

        if (!groups[side].cols[physCol]) groups[side].cols[physCol] = [];
        groups[side].cols[physCol].push(idx);

        // Charlieplex selection
        if (parsedData.pinMap[side].gpios) {
            if (!charlieCounts[side][physRow]) charlieCounts[side][physRow] = 0;
            charlieCounts[side][physRow]++;

            if (!charlieCounts[side][physCol]) charlieCounts[side][physCol] = 0;
            charlieCounts[side][physCol]++;
        }
    });

    // Analyze
    ['left', 'right'].forEach(side => {
        let failuresFound = false;

        // Check for Interrupt GPIO failure (Charlieplex specific)
        if (parsedData.pinMap[side].interrupt && parsedData.pinMap[side].gpios) {
            // Heuristic
            let totalKeysSide = 0;
            let sideTotal = 0;
            for (let r in counts[side].rows) sideTotal += counts[side].rows[r];

            let selectedSideCount = 0;
            // Count selected keys belonging to this side
            selected.forEach(idx => {
                const m = parsedData.matrixMap[idx];
                if (!m) return;
                let s = 'left';
                if (colOffset > 0 && m.c >= colOffset) {
                    s = 'right';
                } else if (rowOffset > 0 && m.r >= rowOffset) {
                    s = 'right';
                }
                if (s === side) selectedSideCount++;
            });

            if (sideTotal > 0 && (selectedSideCount / sideTotal) > 0.8) {
                report.push({
                    type: 'interrupt',
                    side: side,
                    pin: parsedData.pinMap[side].interrupt
                });
                failuresFound = true;
            }
        }

        if (parsedData.pinMap[side].gpios) {
            // Charlieplex Analysis
            const gpios = parsedData.pinMap[side].gpios;
            for (const idxStr in charlieCounts[side]) {
                const idx = parseInt(idxStr);
                const count = charlieCounts[side][idx];
                const total = charlieTotals[side][idx];

                if (total > 0 && (count / total) > 0.5) {
                    const pinName = gpios[idx] || 'Unknown';
                    report.push({
                        type: 'charlie',
                        side: side,
                        index: idx,
                        pin: pinName
                    });
                    failuresFound = true;
                }
            }

        } else {
            // Standard Analysis
            // Rows
            for (const r in groups[side].rows) {
                const count = groups[side].rows[r].length;
                const total = counts[side].rows[r];
                if (count >= 2 && count / total > 0.5) {
                    const pinName = parsedData.pinMap[side].row ? parsedData.pinMap[side].row[r] : 'Unknown';
                    report.push({ type: 'row', side: side, row: r, pin: pinName });
                    failuresFound = true;
                }
            }
            // Cols
            for (const c in groups[side].cols) {
                const count = groups[side].cols[c].length;
                const total = counts[side].cols[c];
                if (count >= 2 && count / total > 0.5) {
                    const pinName = parsedData.pinMap[side].col ? parsedData.pinMap[side].col[c] : 'Unknown';
                    report.push({ type: 'col', side: side, col: c, pin: pinName });
                    failuresFound = true;
                }
            }
        }

        // If no group failures found for this side, report single keys
        if (!failuresFound) {
            selected.forEach(idx => {
                const m = parsedData.matrixMap[idx];
                if (!m) return;
                let s = 'left';
                if (colOffset > 0 && m.c >= colOffset) {
                    s = 'right';
                } else if (rowOffset > 0 && m.r >= rowOffset) {
                    s = 'right';
                }

                // Only add if it belongs to this side (to ensure correct 'side' labeling)
                // Note: 'selected' contains ALL selected keys. failuresFound is per side.
                // This logic might be slightly tricky if one side has failures and other doesn't.
                // Ideally we should track which keys were "explained" by failures.
                // But for now, if a SIDE has no general failures, we assume all selected keys on that side are single faults.

                if (s === side) {
                    report.push({
                        type: 'single',
                        side: side,
                        r: m.r,
                        c: m.c,
                        index: idx
                    });
                }
            });
        }
    });

    return report;
}
