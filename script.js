/**
 * ZMK Debugger Script
 * Parses ZMK configuration files to build a debug interface.
 */

// --- Constants ---
const U = 60; // Render unit size in pixels
const SCALE = 0.6; // Scale factor

// --- State ---
let parsedData = {
    physicalKeys: [],
    matrixMap: [],
    pinMap: { left: {}, right: {} },
    matrixTransform: { rows: 0, cols: 0 }
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
    const folderInput = document.getElementById('folderInput');
    folderInput.addEventListener('change', handleFolderSelect);
    
    document.getElementById('resetBtn').addEventListener('click', resetSelection);
    document.getElementById('diagnoseBtn').addEventListener('click', diagnose);
});


// --- File Parsing Logic ---

async function handleFolderSelect(e) {
    const files = Array.from(e.target.files);
    const statusMsg = document.getElementById('statusMessage');
    
    if (files.length === 0) return;

    statusMsg.textContent = "ファイルを解析中...";
    statusMsg.className = "status-message";

    try {
        const parser = new ZMKParser();
        await parser.processFiles(files);
        
        parsedData = parser.getResult();
        
        console.log("Parsed Data:", parsedData);
        
        if (parsedData.physicalKeys.length === 0) {
            throw new Error("キー配置データ(Physical Layout)が見つかりませんでした。");
        }

        // Init UI
        statusMsg.textContent = "解析完了";
        statusMsg.className = "status-message success";
        document.getElementById('debugInterface').classList.remove('hidden');
        
        initCanvas();

    } catch (err) {
        console.error(err);
        statusMsg.textContent = `エラー: ${err.message}`;
        statusMsg.className = "status-message error";
        document.getElementById('debugInterface').classList.add('hidden');
    }
}

class ZMKParser {
    constructor() {
        this.result = {
            physicalKeys: [], // {x, y, w, h, r, rx, ry}
            matrixMap: [], // {r, c} corresponding to physicalKeys index
            pinMap: { left: {row:{}, col:{}}, right: {row:{}, col:{}} },
            matrixTransform: { rows: 0, cols: 0, colOffset: 0, rowOffset: 0 }
        };
        this.rawFiles = {}; // filename -> content
    }

    async processFiles(files) {
        // 1. Read all text files related to zmk config
        for (const file of files) {
            if (file.name.endsWith('.dtsi') || file.name.endsWith('.overlay') || file.name.endsWith('.conf') || file.name.endsWith('.keymap')) {
                let text = await this.readFile(file);
                text = this.stripComments(text); // Clean up comments
                this.rawFiles[file.name] = text;
            }
        }

        // 2. Parse Physical Layout (usually in a .dtsi file)
        this.findAndParsePhysicalLayout();

        // 3. Parse Matrix Transform (usually in .dtsi)
        this.findAndParseMatrixTransform();

        // 4. Parse Pin Config (usually in .overlay files)
        this.findAndParsePinConfig();
    }

    getResult() {
        return this.result;
    }

    readFile(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = (e) => reject(e);
            reader.readAsText(file);
        });
    }

    stripComments(text) {
        // Remove single-line comments // ...
        // Remove multi-line comments /* ... */
        return text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    }

    findAndParsePhysicalLayout() {
        // 1. Check for "chosen" node to find the specific physical layout label
        let targetLabel = null;
        const chosenRegex = /zmk,physical-layout\s*=\s*&([\w-]+);/;
        
        for (const content of Object.values(this.rawFiles)) {
             // Look for chosen { ... } block
             // Simplified: just look for the property line globally, assuming unique chosen definition
             const match = chosenRegex.exec(content);
             if (match) {
                 targetLabel = match[1];
                 console.log(`Found chosen physical layout label: ${targetLabel}`);
                 break;
             }
        }

        const genericLayoutRegex = /keys\s*=\s*<([\s\S]*?)>;/;
        const keyAttrsRegex = /&key_physical_attrs\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(?:(\(-?\d+\)|-?\d+)\s+(\d+)\s+(\d+)|0\s+0\s+0)/g;

        // 2. Iterate through files to find the layout
        for (const [filename, content] of Object.entries(this.rawFiles)) {
            let layoutContentToParse = content;
            
            // If we have a target label, we must find the node with that label
            if (targetLabel) {
                // Regex to find "label: node-name {"
                // We assume standard DT syntax: label: node { ... }
                const labelRegex = new RegExp(`${targetLabel}\\s*:\\s*[\\w-]+\\s*\\{`);
                const labelMatch = labelRegex.exec(content);
                
                if (labelMatch) {
                    // Start searching for keys property AFTER the label definition
                    const startIndex = labelMatch.index;
                    layoutContentToParse = content.substring(startIndex);
                    console.log(`Found target layout node in ${filename}`);
                } else {
                    // This file doesn't contain the target label, skip blindly if we want to be strict,
                    // but we might just continue loop.
                    continue; 
                }
            } else {
                // No chosen label found. Fallback to searching for "zmk,physical-layout" compatible property or key attrs
                if (!content.includes('zmk,physical-layout') && !content.includes('key_physical_attrs')) {
                    continue;
                }
            }

            // Parse "keys = <...>" in the (possibly truncated) content
            const match = genericLayoutRegex.exec(layoutContentToParse);
            if (match) {
                const keysBlock = match[1];
                let keyMatch;
                while ((keyMatch = keyAttrsRegex.exec(keysBlock)) !== null) {
                    let r = 0, rx = 0, ry = 0;
                    let rawR = "0";

                    if (keyMatch[5]) {
                            rawR = keyMatch[5].replace(/[()]/g, '');
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
                }
                
                if (this.result.physicalKeys.length > 0) {
                    console.log(`Parsed Physical Layout from ${filename} (${this.result.physicalKeys.length} keys)`);
                    return; // Stop after finding the first valid layout matching criteria
                }
            }
        }
    }

    findAndParseMatrixTransform() {
        // Look for matrix transform map
        // map = < ... >
        // RC(r, c)
        
        // Find dtsi with "zmk,matrix-transform"
        const rcRegex = /RC\(\s*(\d+)\s*,\s*(\d+)\s*\)/g;
        const colOffsetRegex = /col-offset\s*=\s*<(\d+)>/;

        for (const [filename, content] of Object.entries(this.rawFiles)) {
            if (content.includes('zmk,matrix-transform')) {
                // Parse Map
                if (content.includes('map = <')) {
                    // Extract map block
                    const mapBlockMatch = /map\s*=\s*<([\s\S]*?)>;/.exec(content);
                    if (mapBlockMatch) {
                        let match;
                        while ((match = rcRegex.exec(mapBlockMatch[1])) !== null) {
                            this.result.matrixMap.push({
                                r: parseInt(match[1]),
                                c: parseInt(match[2])
                            });
                        }
                        console.log(`Found Matrix Map in ${filename}: ${this.result.matrixMap.length} entries`);
                    }
                }
            }
            
            // Look for overlays defining col/row offset (usually separate files, but loop covers all)
            // Actually, offsets are usually in overlays referencing default_transform
            if (content.includes('&default_transform')) {
                 const match = colOffsetRegex.exec(content);
                 if (match) {
                     // Check if this is a "right" side overlay?
                     // naive check: filename contains 'right'
                     if (filename.includes('right')) {
                         this.result.matrixTransform.colOffset = parseInt(match[1]);
                         console.log(`Found Col Offset ${this.result.matrixTransform.colOffset} in ${filename}`);
                     }
                 }
            }
        }
    }
    
    findAndParsePinConfig() {
        // Need to parse &kscan0 nodes in overlays
        // col-gpios = <...>;
        // row-gpios = <...>;
        
        // Helper to extract pin array
        const extractPins = (content, propName) => {
            const pins = [];
            // Regex to find property and its value list
            // prop = < val1 >, < val2 >; or prop = < val1 val2 >;
            // Complex to parse fully with regex, but let's try a best effort
            // Look for `propName =` then capture inside `<...>`.
            // Handles multiline.
            
            const regex = new RegExp(`${propName}\\s*=\\s*([\\s\\S]*?);`, 'g');
            let match;
            
            // We need to find the specific node &kscan0.
            // Simplified: Find content block for &kscan0 or kscan0: kscan0
            
            return pins;
        };
        
        // We will iterate files and just look for kscan definitions
        for (const [filename, content] of Object.entries(this.rawFiles)) {
             if (content.includes('kscan0') || content.includes('zmk,kscan-gpio-matrix')) {
                 // Determine side
                 let side = 'left'; // Default
                 if (filename.includes('right')) side = 'right';
                 
                 // Extract row-gpios
                 this.result.pinMap[side].row = this.parseGpios(content, 'row-gpios');
                 // Extract col-gpios
                 this.result.pinMap[side].col = this.parseGpios(content, 'col-gpios');
                 
                 console.log(`Parsed Pins for ${side} (${filename})`, this.result.pinMap[side]);
             }
        }
    }

    parseGpios(content, propName) {
        // Very rough parser for GPIO list
        // 1. Find the property block
        const regex = new RegExp(`${propName}\\s*=[\\s\\S]*?;`);
        const match = regex.exec(content);
        if (!match) return {};
        
        const block = match[0];
        // 2. Extract <...> items
        // Example: <&xiao_d 0 (GPIO_ACTIVE_HIGH | GPIO_PULL_DOWN)>
        // Example: <&gpio0 9 GPIO_ACTIVE_HIGH>
        
        const itemRegex = /<([^>]+)>/g;
        let itemMatch;
        const pins = {};
        let idx = 0;
        
        while ((itemMatch = itemRegex.exec(block)) !== null) {
            const val = itemMatch[1].trim(); // "&xiao_d 0 (GPIO...)"
            
            // Cleanup to get readable name
            // Remove flags (...) or GPIO_...
            let readable = val.replace(/\([^)]+\)/g, '').replace(/GPIO_[A-Z_]+/g, '').trim();
            // Simplify "&xiao_d 0" -> "D0" if possible, or keep as is
            
            if (readable.includes('&xiao_d')) {
                const num = readable.split(/\s+/).pop();
                readable = `D${num} (xiao_d ${num})`;
            } else if (readable.includes('&gpio')) {
                 // &gpio0 9 -> P0.09? Just keep as is
            }
            
            pins[idx] = readable;
            idx++;
        }
        return pins;
    }
}


// --- Canvas & Rendering ---

const canvas = document.getElementById('keyboardCanvas');
const ctx = canvas.getContext('2d');

function initCanvas() {
    if (parsedData.physicalKeys.length === 0) return;

    // Calculate bounds
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
        ctx.fillText(`C${m.c}, R${m.r}`, x + w/2, y + h/2);
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
    // Reverse transform check
    for (let i = 0; i < parsedData.physicalKeys.length; i++) {
        const k = parsedData.physicalKeys[i];
        
        let tx = screenX;
        let ty = screenY;

        if (k.r) {
            const cx = k.rx * U;
            const cy = k.ry * U;
            
            // Translate to origin
            let dx = tx - cx;
            let dy = ty - cy;
            
            // Rotate backwards
            const rad = -k.r * Math.PI / 180;
            const cos = Math.cos(rad);
            const sin = Math.sin(rad);
            
            const rdx = dx * cos - dy * sin;
            const rdy = dx * sin + dy * cos;
            
            tx = rdx + cx;
            ty = rdy + cy;
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

    if (failures.length === 0) {
        const li = document.createElement('li');
        li.className = 'diagnosis-item';
        li.innerHTML = `<strong>個別の接触不良の可能性</strong><p>選択されたキーのソケット、スイッチ、またはダイオードを確認してください。</p>`;
        ul.appendChild(li);
    } else {
        failures.forEach(f => {
            const li = document.createElement('li');
            li.className = 'diagnosis-item';
            
            let title = '';
            let desc = '';
            
            if (f.type === 'row') {
                title = `行 (Row) 全体の不具合 - ${f.side} Side`;
                desc = `Row Index: ${f.row}<br>Pin: <strong>${f.pin || 'Unknown'}</strong><br>このRowの配線またはマイコンのピンを確認してください。`;
            } else if (f.type === 'col') {
                title = `列 (Column) 全体の不具合 - ${f.side} Side`;
                desc = `Col Index: ${f.col}<br>Pin: <strong>${f.pin || 'Unknown'}</strong><br>このColumnの配線またはマイコンのピンを確認してください。`;
            }
            
            li.innerHTML = `<strong>${title}</strong><p>${desc}</p>`;
            ul.appendChild(li);
        });
    }

    resultContent.appendChild(ul);
}


function analyzeFailures() {
    const selected = Array.from(state.selectedIndices);
    const report = [];

    // Identify splitting point based on Matrix Map Columns
    // Often left is 0..N, Right is N+1..M?
    // Or mapped via col-offset.
    // ZaruBall: Left cols 0-6, Right (phys 0-5) mapped to 7-12.
    // We can infer side based on col index if we assume split.
    
    const offset = parsedData.matrixTransform.colOffset || 0;
    
    // Auto-detect split boundary if not explicit?
    // If we have an offset > 0, we assume anything >= offset is "Right" side logical cols.
    // But physically they map to 0-based pins on the slave side.
    
    const groups = { left: { rows: {}, cols: {} }, right: { rows: {}, cols: {} } };
    const counts = { left: { rows: {}, cols: {} }, right: { rows: {}, cols: {} } };
    
    // Count totals first
    parsedData.matrixMap.forEach((m, idx) => {
        if (!m) return; // Unmapped key?
        
        let side = 'left';
        let physCol = m.c;
        
        if (offset > 0 && m.c >= offset) {
            side = 'right';
            physCol = m.c - offset;
        }

        if (!counts[side].rows[m.r]) counts[side].rows[m.r] = 0;
        counts[side].rows[m.r]++;
        
        if (!counts[side].cols[physCol]) counts[side].cols[physCol] = 0;
        counts[side].cols[physCol]++;
    });


    // Group selected
    selected.forEach(idx => {
        const m = parsedData.matrixMap[idx];
        if (!m) return;
        
        let side = 'left';
        let physCol = m.c;
        
        if (offset > 0 && m.c >= offset) {
            side = 'right';
            physCol = m.c - offset;
        }
        
        if (!groups[side].rows[m.r]) groups[side].rows[m.r] = [];
        groups[side].rows[m.r].push(idx);
        
        if (!groups[side].cols[physCol]) groups[side].cols[physCol] = [];
        groups[side].cols[physCol].push(idx);
    });

    // Analyze
    ['left', 'right'].forEach(side => {
        // Rows
        for (const r in groups[side].rows) {
            const count = groups[side].rows[r].length;
            const total = counts[side].rows[r];
            if (count >= 3 || (total > 0 && count === total)) { // Threshold
                 const pinName = parsedData.pinMap[side].row[r];
                 report.push({ type: 'row', side: side, row: r, pin: pinName });
            }
        }
        // Cols
        for (const c in groups[side].cols) {
            const count = groups[side].cols[c].length;
            const total = counts[side].cols[c];
            if (count >= 3 || (total > 0 && count === total)) {
                 const pinName = parsedData.pinMap[side].col[c];
                 report.push({ type: 'col', side: side, col: c, pin: pinName });
            }
        }
    });

    return report;
}
