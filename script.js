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
    selectedIndices: new Set(),
    issueMapping: new Map() // index -> color
};

const ISSUE_COLORS = [
    '#3b82f6', // Blue
    '#f59e0b', // Amber
    '#10b981', // Emerald
    '#8b5cf6', // Violet
    '#f43f5e', // Rose
    '#06b6d4', // Cyan
    '#6366f1', // Indigo
    '#84cc16'  // Lime
];

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

    const dbFileInput = document.getElementById('dbFileInput');
    if (dbFileInput) {
        dbFileInput.addEventListener('change', handleManualDatabaseUpload);
    }

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
        // Try to fetch matrix-diagnoser-database.json
        setStatus("データベース検索中...", "loading");
        try {
            parsedData.database = await fetcher.fetchDatabase();
            const dlContainer = document.getElementById('dlTemplateContainer');
            const manualSection = document.getElementById('dbManualSection');
            if (parsedData.database) {
                console.log("Database loaded successfully.");
                dlContainer.classList.add('hidden');
                manualSection.classList.add('hidden');
            } else {
                console.warn("Database not found.");
                dlContainer.classList.remove('hidden');
                manualSection.classList.remove('hidden');
            }
        } catch (e) {
            console.warn("Database fetch failed", e);
            document.getElementById('dlTemplateContainer').classList.remove('hidden');
            document.getElementById('dbManualSection').classList.remove('hidden');
        }

        // Init UI
        setStatus("解析完了", "success");
        document.getElementById('debugInterface').classList.remove('hidden');
        document.getElementById('repoInstruction').classList.add('hidden'); // Hide instructions
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
        // Try fetching matrix-diagnoser-database.json from root or config directory
        const dbName = 'matrix-diagnoser-database.json';
        const paths = [
            dbName,
            `config/${dbName}`,
            'database.json' // Legacy support
        ];

        for (const path of paths) {
            const url = `https://raw.githubusercontent.com/${this.repo}/${this.branch || 'main'}/${path}`;
            try {
                const res = await fetch(url);
                if (res.ok) {
                    console.log(`Found database at: ${url}`);
                    return await res.json();
                }
            } catch (e) {
                console.log(`Failed to fetch database at ${url}:`, e);
            }
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
            pinMap: {}, // Dynamically keyed by shield name
            matrixTransform: { rows: 0, cols: 0, colOffset: 0, rowOffset: 0 },
            diodeDirection: 'col2row'
        };
        this.rawFiles = {};
        this.shields = []; // List of shield names
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
        this.shields = [];
        for (const [name, content] of Object.entries(this.rawFiles)) {
            if (name.endsWith('build.yaml')) {
                console.log(`Found build.yaml: ${name}`);
                // Match lines like "shield: mona2_r" or "shield: [corne_left, rpi_pico]"
                const lines = content.split('\n');
                lines.forEach(line => {
                    const match = line.match(/shield:\s*(.*)/);
                    if (match) {
                        let value = match[1].trim();
                        // Remove potential trailing comma or brackets if it's a multi-line list start
                        // but let's assume standard single-line or bracketed line for now
                        value = value.replace(/[\[\]]/g, ''); // Remove [ and ]
                        
                        const entries = value.split(',');
                        entries.forEach(entry => {
                            // Clean up quotes and take the first part
                            let shieldEntry = entry.trim().replace(/["']/g, ''); // Remove " and '
                            const baseShield = shieldEntry.split(/\s+/)[0];
                            
                            if (baseShield && baseShield !== 'settings_reset' && !this.shields.includes(baseShield)) {
                                this.shields.push(baseShield);
                                if (!this.result.pinMap[baseShield]) {
                                    this.result.pinMap[baseShield] = { row: {}, col: {} };
                                }
                                console.log(`Identified Shield: ${baseShield}`);
                            }
                        });
                    }
                });
            }
        }
    }

    stripComments(text) {
        // Remove C-style // and /* */, and Hash-style # comments
        return text.replace(/\/\/.*$/gm, '')
                   .replace(/\/\*[\s\S]*?\*\//g, '')
                   .replace(/#.*$/gm, '');
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
        const rowOffsetRegex = /row-offset\s*=\s*<(\d+)>/;

        for (const [filename, content] of Object.entries(this.rawFiles)) {
            // Identify side/shield based on filename
            let shieldName = 'common';
            for (const s of this.shields) {
                if (filename.includes(s)) {
                    shieldName = s;
                    break;
                }
            }

            // Transform Map
            if (content.includes('map = <')) {
                const mapBlockMatch = /map\s*=\s*<([\s\S]*?)>;/.exec(content);
                if (mapBlockMatch) {
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
                if (match && shieldName !== 'common') {
                    if (!this.result.pinMap[shieldName]) this.result.pinMap[shieldName] = { row: {}, col: {} };
                    this.result.pinMap[shieldName].colOffset = parseInt(match[1]);
                    console.log(`Found Col Offset ${this.result.pinMap[shieldName].colOffset} for ${shieldName} in ${filename}`);
                }
            }

            // Row Offset
            if (content.includes('row-offset')) {
                const match = rowOffsetRegex.exec(content);
                if (match && shieldName !== 'common') {
                    if (!this.result.pinMap[shieldName]) this.result.pinMap[shieldName] = { row: {}, col: {} };
                    this.result.pinMap[shieldName].rowOffset = parseInt(match[1]);
                    console.log(`Found Row Offset ${this.result.pinMap[shieldName].rowOffset} for ${shieldName} in ${filename}`);
                }
            }
        }
    }

    findAndParsePinConfig() {
        for (const [filename, content] of Object.entries(this.rawFiles)) {
            // Parse diode-direction
            const diodeMatch = /diode-direction\s*=\s*"([^"]+)"/.exec(content);
            if (diodeMatch) {
                this.result.diodeDirection = diodeMatch[1];
                console.log(`Found diode-direction: ${this.result.diodeDirection} in ${filename}`);
            }

            // Identify side based on shields from build.yaml
            let side = 'common';
            for (const shield of this.shields) {
                if (filename.includes(shield)) {
                    side = shield;
                    break;
                }
            }

            const targetSides = side === 'common' ? this.shields : [side];
            if (targetSides.length === 0 && side === 'common') {
                // Fallback if no build.yaml or shields found yet
                // (though build.yaml should be parsed first)
                continue; 
            }

            // Standard Matrix
            if (content.includes('row-gpios') || content.includes('col-gpios')) {
                const rowGpios = this.extractGpioList(content, 'row-gpios');
                const colGpios = this.extractGpioList(content, 'col-gpios');

                targetSides.forEach(s => {
                    if (!this.result.pinMap[s]) this.result.pinMap[s] = { row: {}, col: {} };
                    if (Object.keys(rowGpios).length > 0) Object.assign(this.result.pinMap[s].row, rowGpios);
                    if (Object.keys(colGpios).length > 0) Object.assign(this.result.pinMap[s].col, colGpios);
                });
                console.log(`Parsed Standard Pins for ${side} (applied to ${targetSides.join(', ')})`);
            }

            // Charlieplex
            const hasGpios = /(?:^|[\s;])gpios\s*=/.test(content);
            const isCharlieMode = (content.includes('compatible') && content.includes('zmk,kscan-gpio-charlieplex')) || 
                                (hasGpios && !content.includes('row-gpios') && !content.includes('col-gpios'));

            if (isCharlieMode) {
                const gpios = this.extractGpioList(content, 'gpios');
                const intGpios = this.extractGpioList(content, 'interrupt-gpios');

                targetSides.forEach(s => {
                    if (!this.result.pinMap[s]) this.result.pinMap[s] = { row: {}, col: {} };
                    if (Object.keys(gpios).length > 0) {
                        if (!this.result.pinMap[s].gpios) this.result.pinMap[s].gpios = {};
                        Object.assign(this.result.pinMap[s].gpios, gpios);
                        this.result.diodeDirection = 'col2row'; // Charlieplex is always col2row
                    }
                    if (Object.keys(intGpios).length > 0) {
                        this.result.pinMap[s].interrupt = Object.values(intGpios)[0];
                    }
                });
                console.log(`Parsed Charlieplex/GPIO Pins for ${side} (applied to ${targetSides.join(', ')})`);
            }

            // Direct GPIO
            const isDirectMode = (content.includes('compatible') && content.includes('zmk,kscan-gpio-direct')) || 
                               (content.includes('input-gpios') && !content.includes('row-gpios') && !content.includes('col-gpios'));
            
            if (isDirectMode) {
                const directGpios = this.extractGpioList(content, 'input-gpios');
                targetSides.forEach(s => {
                    if (!this.result.pinMap[s]) this.result.pinMap[s] = { row: {}, col: {} };
                    if (Object.keys(directGpios).length > 0) {
                        if (!this.result.pinMap[s].direct) this.result.pinMap[s].direct = {};
                        Object.assign(this.result.pinMap[s].direct, directGpios);
                        this.result.diodeDirection = 'row2col'; // Direct is often row2col (Row 0 is GND)
                    }
                });
                console.log(`Parsed Direct Pins for ${side} (applied to ${targetSides.join(', ')})`);
            }
        }
    }

    extractGpioList(content, propName) {
        // Regex to match "propName = < ... >;" (multiline)
        // Ensure the character before propName is not a hyphen or word char.
        // JS doesn't always support (?<!), so use (^|[\s;]) prefix.
        const regex = new RegExp(`(?:^|[\\s;])${propName}\\s*=[\\s\\S]*?<([\\s\\S]*?);`);
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

    const issueColor = state.issueMapping.get(index);
    if (issueColor) {
        ctx.fillStyle = issueColor;
        ctx.strokeStyle = issueColor; // Use same color for stroke to pop
    } else {
        ctx.fillStyle = isSelected ? themeColors.keySelected : themeColors.keyDefault;
        ctx.strokeStyle = isSelected ? themeColors.keySelectedStroke : themeColors.keyStroke;
    }
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
        // If selection changes, previous diagnosis is invalid
        state.issueMapping.clear();
        document.getElementById('resultArea').classList.add('hidden');

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
    state.issueMapping.clear();
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

    state.issueMapping.clear();
    const failures = analyzeFailures();
    const ul = document.createElement('ul');
    ul.className = 'diagnosis-list';

    failures.forEach((f, fIdx) => {
        const color = ISSUE_COLORS[fIdx % ISSUE_COLORS.length];
        
        // Map keys to this color
        if (f.indices) {
            f.indices.forEach(kIdx => {
                // If a key is part of multiple issues, the first one found wins or we can overwrite
                if (!state.issueMapping.has(kIdx)) {
                    state.issueMapping.set(kIdx, color);
                }
            });
        }

        const li = document.createElement('li');
        li.className = `diagnosis-item type-${f.type}`;
        // Set CSS variable for the theme color
        li.style.setProperty('--issue-color', color);
        
        let title = '';
        let desc = '';

        if (f.type === 'row') {
            const info = getPinInfo(f.side, f.pin);
            const silkName = info.silk === f.pin ? `${f.pin}` : info.silk;
            title = `行 (Row) 全体の不具合 - ${f.side}`;
            desc = `Pin: <strong>${silkName}</strong>`;
            desc += `<div class="cause-box">
                <strong>原因の候補:</strong><br>
                このマイコンのピン (${silkName}) のハンダ付けを確認してください。
            </div>`;
        } else if (f.type === 'col') {
            const info = getPinInfo(f.side, f.pin);
            const silkName = info.silk === f.pin ? `${f.pin}` : info.silk;
            title = `列 (Column) 全体の不具合 - ${f.side}`;
            desc = `Pin: <strong>${silkName}</strong>`;
            desc += `<div class="cause-box">
                <strong>原因の候補:</strong><br>
                このマイコンのピン (${silkName}) のハンダ付けを確認してください。
            </div>`;
        } else if (f.type === 'charlie') {
            const info = getPinInfo(f.side, f.pin);
            const silkName = info.silk === f.pin ? `${f.pin}` : info.silk;
            const isInputFail = f.roleFail === 'in';
            const isOutputFail = f.roleFail === 'out';
            const isBothFail = f.roleFail === 'both';
            
            title = `Charlieplex GPIO ピン不具合 - ${f.side}`;
            desc = `Pin: <strong>${silkName}</strong>`;
            
            if (isInputFail) {
                desc += `<br>状態: <strong>信号受信用 (Input) としての動作不良</strong>`;
                let diodeInfo = '';
                if (info.line_diode) {
                    diodeInfo += `Line Diode: <strong>${info.line_diode}</strong><br>`;
                } else {
                    diodeInfo += `<strong>(関連する Line Diode)</strong><br>`;
                }
                if (info.interrupt_diode) {
                    diodeInfo += `Interrupt Diode: <strong>${info.interrupt_diode}</strong><br>`;
                } else { // Heuristic: Charlieplex pins usually have Int Diodes
                    diodeInfo += `<strong>(関連する Interrupt Diode)</strong><br>`;
                }
                
                desc += `<div class="cause-box">
                    <strong>原因の候補:</strong><br>
                    ${diodeInfo}
                    マイコンピン: <strong>${silkName}</strong><br>
                    いずれかのハンダ不良が考えられます。
                </div>`;
            } else if (isOutputFail) {
                desc += `<br>状態: <strong>信号送信用 (Output) としての動作不良</strong>`;
                desc += `<div class="cause-box">
                    <strong>原因の候補:</strong><br>
                    マイコンピン: <strong>${silkName}</strong> のハンダ不良が考えられます。<br>
                    (ダイオード故障では通常、送信側は影響を受けません)
                </div>`;
            } else if (isBothFail) {
                desc += `<br>状態: <strong>送受信（双方向）の動作不良</strong>`;
                desc += `<div class="cause-box">
                    <strong>原因の候補:</strong><br>
                    マイコンピン: <strong>${silkName}</strong> のハンダ不良が最も疑われます。
                </div>`;
            }
            
            desc += `<br>このピンに関連する配線全体（複数のRow/Col）を確認してください。`;
        } else if (f.type === 'direct') {
            const info = getPinInfo(f.side, f.pin);
            const m = parsedData.matrixMap[f.indices[0]]; // Assuming direct failure is for a single key
            const silkName = getKeyInfo(m.r, m.c)?.silk_sw || `SW (RC:${m.r},${m.c})`;
            title = "Direct GPIO 故障 - " + f.side;
            desc = `スイッチ <strong>${silkName}</strong> が反応していません。`;
            desc += `<br>このキーは GPIO ピン <strong>${info.silk}</strong> に直接接続されています。`;
            desc += `<div class="cause-box">
                <strong>原因の候補:</strong><br>
                1. マイコンピン <strong>${info.silk}</strong> のハンダ不良<br>
                2. スイッチ <strong>${silkName}</strong> 本体の故障またはハンダ不良<br>
                3. スイッチソケットの浮き・ハンダ不良
            </div>`;
            desc += `<br>※この構成ではダイオードを使用しないため、スイッチ周りとマイコンピンの直通確認を行ってください。`;
        } else if (f.type === 'direct_gnd') {
            title = "共通 GND 不良の疑い - " + f.side;
            const count = f.indices.length;
            desc = `このシールドのほぼ全てのキー（${count}個）が反応していません。`;
            desc += `<br>Direct GPIO 方式では、全スイッチが共通の GND ピンを共有しています。`;
            desc += `<div class="cause-box">
                <strong>原因の候補:</strong><br>
                1. <strong>共通 GND ピン</strong>（マイコンまたは基板側）のハンダ不良<br>
                2. 基板上の GND パターンの断線<br>
                3. 電源周りの不備
            </div>`;
            desc += `<br>個別ピンの確認の前に、まずは GND ピンが確実にハンダ付けされているか確認してください。`;
        } else if (f.type === 'interrupt') {
            const info = getPinInfo(f.side, f.pin);
            const silkName = info.silk === f.pin ? `${f.pin}` : info.silk;
            title = `割り込み (Interrupt) GPIO 不具合 - ${f.side}`;
            desc = `Pin: <strong>${silkName}</strong>`;
            desc += `<div class="cause-box">
                <strong>対策:</strong><br>
                このピンが浮いている、または導通していないと、当該サイドの全てのキー入力が反応しません。
                ハンダ付けを再確認してください。
            </div>`;
        } else if (f.type === 'single') {
            const matrixR = f.r;
            const matrixC = f.c;
            const keyInfo = getKeyInfo(matrixR, matrixC);

            title = `個別キーの不具合 - ${f.side}`;
            if (keyInfo) {
                desc = `Matrix: ${matrixR}, ${matrixC}`;
                desc += `<div class="cause-box">
                    <strong>確認部品:</strong><br>
                    Switch: <strong>${keyInfo.silk_sw}</strong><br>
                    Diode: <strong>${keyInfo.silk_d || '(関連するダイオード)'}</strong><br>
                    該当するスイッチソケットおよびダイオードのハンダ付けを確認してください。
                </div>`;
            } else {
                desc = `Matrix: ${matrixR}, ${matrixC}`;
                desc += `<div class="cause-box">
                    <strong>確認内容:</strong><br>
                    個別の接触不良が考えられます。<br>
                    対象のスイッチと対応するスイッチソケット、ダイオードのハンダ付けを確認してください。
                </div>`;
            }
        }

        li.innerHTML = `<strong>${title}</strong><p>${desc}</p>`;
        ul.appendChild(li);
    });

    initCanvas(); // Redraw with colors
    resultContent.appendChild(ul);
}



function getPinInfo(side, rawPinName) {
    // 1. Try shield-specific key (e.g. "corne_left_10")
    const specificKey = `${side}_${rawPinName}`;
    if (parsedData.database && parsedData.database.pins && parsedData.database.pins[specificKey]) {
        return parsedData.database.pins[specificKey];
    }
    
    // 2. Try legacy Left/Right prefix for compatibility
    const isLeft = side.toLowerCase().includes('left') || side === 'left';
    const legacyKey = `${isLeft ? 'Left' : 'Right'}_${rawPinName}`;
    if (parsedData.database && parsedData.database.pins && parsedData.database.pins[legacyKey]) {
        return parsedData.database.pins[legacyKey];
    }

    // 3. Try raw pin name
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
    // Iterate all effectively parsed shields
    Object.keys(parsedData.pinMap).forEach(shieldName => {
        const pm = parsedData.pinMap[shieldName];
        if (!pm) return;

        // Key helper
        const getPinKey = (p) => `${shieldName}_${p}`;

        // Standard Row/Col
        if (pm.row) {
            Object.values(pm.row).forEach(p => {
                const key = getPinKey(p);
                if (!db.pins[key]) db.pins[key] = { silk: "", line_diode: "", interrupt_diode: "" };
            });
        }
        if (pm.col) {
            Object.values(pm.col).forEach(p => {
                const key = getPinKey(p);
                if (!db.pins[key]) db.pins[key] = { silk: "", line_diode: "", interrupt_diode: "" };
            });
        }

        // Charlieplex
        if (pm.gpios) {
            Object.values(pm.gpios).forEach(p => {
                const key = getPinKey(p);
                if (!db.pins[key]) db.pins[key] = { silk: "", line_diode: "", interrupt_diode: "" };
            });
        }

        // Direct
        if (pm.direct) {
            Object.values(pm.direct).forEach(p => {
                const key = getPinKey(p);
                if (!db.pins[key]) db.pins[key] = { silk: "", line_diode: "", interrupt_diode: "" };
            });
        }

        // Interrupt
        if (pm.interrupt) {
            const p = pm.interrupt;
            const key = getPinKey(p);
            if (!db.pins[key]) db.pins[key] = { silk: "", description: "" };
        }
    });

    // 2. Populate Keys
    parsedData.matrixMap.forEach((m, i) => {
        if (!m) return;
        db.keys.push({
            matrix: [m.r, m.c],
            silk_sw: "",
            silk_d: ""
        });
    });

    return JSON.stringify(db, null, 2);
}

async function handleManualDatabaseUpload(e) {
    const file = e.target.files[0];
    if (!file) return;

    try {
        const text = await file.text();
        const json = JSON.parse(text);
        parsedData.database = json;
        console.log("Manual database loaded:", json);
        
        setStatus("手動データベースを読み込みました", "success");
        document.getElementById('dlTemplateContainer').classList.add('hidden');
        document.getElementById('dbManualSection').classList.add('hidden');
        
        // Redraw diagnosis if result area is visible
        if (!document.getElementById('resultArea').classList.contains('hidden')) {
            diagnose();
        }
    } catch (err) {
        console.error("Manual DB upload failed:", err);
        setStatus("DBファイルの読み込みに失敗しました。", "error");
    }
}

function downloadTemplate() {
    const json = generateDatabaseTemplate();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'matrix-diagnoser-database.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}


function analyzeFailures() {
    const selected = Array.from(state.selectedIndices);
    const report = [];
    
    // 1. Identify valid shields (those with pin definitions)
    const validShields = Object.keys(parsedData.pinMap).filter(s => {
        const p = parsedData.pinMap[s];
        return (p.row && Object.keys(p.row).length > 0) || 
               (p.col && Object.keys(p.col).length > 0) || 
               (p.gpios && Object.keys(p.gpios).length > 0) ||
               (p.direct && Object.keys(p.direct).length > 0);
    });

    if (validShields.length === 0) return [];

    // Helper to determine which shield a key belongs to and its local physical coordinates
    const getSideAndPhysCoords = (m) => {
        if (!m) return { side: validShields[0] || 'common', physC: 0, physR: 0 };
        let bestShield = validShields[0];
        let maxMatchScore = -1;
        let physC = m.c;
        let physR = m.r;

        validShields.forEach(s => {
            const offsetC = parsedData.pinMap[s].colOffset || 0;
            const offsetR = parsedData.pinMap[s].rowOffset || 0;
            
            // Check if coordinates are within range (>= offset)
            if (m.c >= offsetC && m.r >= offsetR) {
                // The "best match" is the one with the largest offset that still contains the target
                // This correctly handles split configurations where right side starts at some offset
                const score = offsetC + offsetR;
                if (score > maxMatchScore) {
                    maxMatchScore = score;
                    bestShield = s;
                    physC = m.c - offsetC;
                    physR = m.r - offsetR;
                }
            }
        });

        return { side: bestShield, physC, physR };
    };

    const groups = {};
    const counts = {};
    const charlieCounts = {};
    const charlieTotals = {};
    
    validShields.forEach(s => {
        groups[s] = { rows: {}, cols: {} };
        counts[s] = { rows: {}, cols: {} };
        charlieCounts[s] = { in: {}, out: {} };
        charlieTotals[s] = { in: {}, out: {} };
    });

    // 2. Calculate totals for each side/physical coordinate
    parsedData.matrixMap.forEach((m) => {
        if (!m) return;
        const { side, physC, physR } = getSideAndPhysCoords(m);

        if (!counts[side]) return;

        if (!counts[side].rows[physR]) counts[side].rows[physR] = 0;
        counts[side].rows[physR]++;
        if (!counts[side].cols[physC]) counts[side].cols[physC] = 0;
        counts[side].cols[physC]++;

        if (parsedData.pinMap[side].gpios) {
            charlieTotals[side].in[physR] = (charlieTotals[side].in[physR] || 0) + 1;
            charlieTotals[side].out[physC] = (charlieTotals[side].out[physC] || 0) + 1;
        }

        // Direct mode totals (each key is unique)
        if (parsedData.pinMap[side].direct) {
            // No aggregation needed for direct, but we use the counts/totals structure to track it
        }
    });

    // 3. Group selected keys
    selected.forEach(idx => {
        const m = parsedData.matrixMap[idx];
        if (!m) return;
        const { side, physC, physR } = getSideAndPhysCoords(m);

        if (!groups[side]) return;

        if (!groups[side].rows[physR]) groups[side].rows[physR] = [];
        groups[side].rows[physR].push(idx);
        if (!groups[side].cols[physC]) groups[side].cols[physC] = [];
        groups[side].cols[physC].push(idx);

        if (parsedData.pinMap[side].gpios) {
            charlieCounts[side].in[physR] = (charlieCounts[side].in[physR] || 0) + 1;
            charlieCounts[side].out[physC] = (charlieCounts[side].out[physC] || 0) + 1;
        }
    });

    const coveredIndices = new Set();

    // 4. Analyze each side
    validShields.forEach(side => {
        const pMap = parsedData.pinMap[side];
        if (!pMap) return;

        // --- Interrupt logic ---
        if (pMap.interrupt) {
            let sideTotal = 0;
            const sideIndices = [];
            parsedData.matrixMap.forEach((m, idx) => {
                if (!m) return;
                const pos = getSideAndPhysCoords(m);
                if (pos.side === side) {
                    sideTotal++;
                    sideIndices.push(idx);
                }
            });

            const selectedOnSide = selected.filter(idx => {
                const m = parsedData.matrixMap[idx];
                return m && getSideAndPhysCoords(m).side === side;
            }).length;

            if (sideTotal > 5 && (selectedOnSide / sideTotal) > 0.8) {
                report.push({ 
                    type: 'interrupt', 
                    side, 
                    pin: pMap.interrupt,
                    indices: sideIndices
                });
                sideIndices.forEach(idx => coveredIndices.add(idx));
            }
        }

        // --- Charlieplex Analysis ---
        if (pMap.gpios) {
            const gpios = pMap.gpios;
            const allIndices = new Set([
                ...(charlieTotals[side] ? Object.keys(charlieTotals[side].in) : []),
                ...(charlieTotals[side] ? Object.keys(charlieTotals[side].out) : [])
            ]);

            allIndices.forEach(idxStr => {
                const pIdx = parseInt(idxStr);
                const inCount = charlieCounts[side].in[pIdx] || 0;
                const inTotal = charlieTotals[side].in[pIdx] || 0;
                const outCount = charlieCounts[side].out[pIdx] || 0;
                const outTotal = charlieTotals[side].out[pIdx] || 0;

                const inFail = inTotal > 0 && (inCount / inTotal) > 0.6;
                const outFail = outTotal > 0 && (outCount / outTotal) > 0.6;

                if (inFail || outFail) {
                    let roleFail = 'both';
                    if (inFail && !outFail) roleFail = 'in';
                    else if (!inFail && outFail) roleFail = 'out';
                    
                    // Collect indices involved
                    const indices = [];
                    parsedData.matrixMap.forEach((m, kIdx) => {
                        if (!m) return;
                        const pos = getSideAndPhysCoords(m);
                        if (pos.side === side) {
                            if (roleFail === 'in' && pos.physR === pIdx) indices.push(kIdx);
                            else if (roleFail === 'out' && pos.physC === pIdx) indices.push(kIdx);
                            else if (roleFail === 'both' && (pos.physR === pIdx || pos.physC === pIdx)) indices.push(kIdx);
                        }
                    });

                    const involvedSelected = indices.filter(idx => selected.includes(idx));
                    report.push({ 
                        type: 'charlie', 
                        side, 
                        index: pIdx, 
                        pin: gpios[pIdx] || 'Unknown',
                        roleFail: roleFail,
                        indices: involvedSelected
                    });
                    involvedSelected.forEach(idx => coveredIndices.add(idx));
                }
            });
        } else if (pMap.direct) {
            // --- Direct GPIO Analysis ---
            // Count direct keys on this side
            const directIndices = [];
            parsedData.matrixMap.forEach((m, idx) => {
                if (!m) return;
                const pos = getSideAndPhysCoords(m);
                if (pos.side === side && pMap.direct[pos.physC] !== undefined) {
                    directIndices.push(idx);
                }
            });

            const selectedDirectOnSide = directIndices.filter(idx => selected.includes(idx));
            
            // If many direct keys are failing (e.g. > 80%), it's likely a common GND issue
            if (directIndices.length > 2 && (selectedDirectOnSide.length / directIndices.length) > 0.8) {
                report.push({
                    type: 'direct_gnd',
                    side,
                    indices: directIndices
                });
                directIndices.forEach(idx => coveredIndices.add(idx));
            } else {
                // Otherwise report individual pin failures
                selectedDirectOnSide.forEach(idx => {
                    const m = parsedData.matrixMap[idx];
                    const pos = getSideAndPhysCoords(m);
                    const pin = pMap.direct[pos.physC] || 'Unknown';
                    report.push({
                        type: 'direct',
                        side,
                        pin,
                        index: idx,
                        indices: [idx]
                    });
                    coveredIndices.add(idx);
                });
            }
        } else {
            // --- Standard Matrix Analysis ---
            // Rows
            if (groups[side] && groups[side].rows) {
                for (const rStr in groups[side].rows) {
                    const physR = parseInt(rStr);
                    const count = groups[side].rows[physR].length;
                    const total = counts[side].rows[physR];
                    if (total > 0 && (count / total) > 0.6) {
                        const pin = pMap.row ? pMap.row[physR] : 'Unknown';
                        report.push({ 
                            type: 'row', 
                            side, 
                            row: physR, 
                            pin,
                            indices: groups[side].rows[physR]
                        });
                        groups[side].rows[physR].forEach(idx => coveredIndices.add(idx));
                    }
                }
            }
            // Cols
            if (groups[side] && groups[side].cols) {
                for (const cStr in groups[side].cols) {
                    const physC = parseInt(cStr);
                    const count = groups[side].cols[physC].length;
                    const total = counts[side].cols[physC];
                    if (total > 0 && (count / total) > 0.6) {
                        const pin = pMap.col ? pMap.col[physC] : 'Unknown';
                        report.push({ 
                            type: 'col', 
                            side, 
                            col: physC, 
                            pin,
                            indices: groups[side].cols[physC]
                        });
                        groups[side].cols[physC].forEach(idx => coveredIndices.add(idx));
                    }
                }
            }
        }

        // --- Single Key Failures (Always check for uncovered indices) ---
        selected.forEach(idx => {
            if (coveredIndices.has(idx)) return; // Already explained by row/col/charlie/interrupt
            
            const m = parsedData.matrixMap[idx];
            if (!m) return;
            const info = getSideAndPhysCoords(m);
            if (info.side === side) {
                report.push({ 
                    type: 'single', 
                    side, 
                    r: m.r, 
                    c: m.c, 
                    index: idx,
                    indices: [idx]
                });
            }
        });
    });

    return report;
}
