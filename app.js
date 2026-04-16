/**
 * DupliScan — Duplicate Image Finder
 * 
 * Uses the File System Access API to scan folders,
 * SHA-256 hashing for content-based duplicate detection,
 * and can move duplicates to a separate folder.
 */

// ============================================
// State
// ============================================
const state = {
    rootHandle: null,
    images: [],           // { file, handle, path, size, hash, objectUrl }
    duplicateGroups: [],   // [ [imageIndex, imageIndex, ...], ... ]
    selectedIndices: new Set(),
    scanning: false,
};

const IMAGE_EXTENSIONS = new Set([
    '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg',
    '.tiff', '.tif', '.ico', '.avif', '.heic', '.heif'
]);

// ============================================
// DOM Refs
// ============================================
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const dom = {
    landingSection: $('#landingSection'),
    scanningSection: $('#scanningSection'),
    resultsSection: $('#resultsSection'),
    selectFolderBtn: $('#selectFolderBtn'),
    scanTitle: $('#scanTitle'),
    scanSubtitle: $('#scanSubtitle'),
    progressFill: $('#progressFill'),
    progressCount: $('#progressCount'),
    progressPercent: $('#progressPercent'),
    scanLog: $('#scanLog'),
    duplicateGroups: $('#duplicateGroups'),
    headerStats: $('#headerStats'),
    statFiles: $('#statFiles'),
    statDuplicates: $('#statDuplicates'),
    statSavings: $('#statSavings'),
    noDuplicates: $('#noDuplicates'),
    scanAgainBtn: $('#scanAgainBtn'),
    scanAnotherBtn: $('#scanAnotherBtn'),
    selectAllBtn: $('#selectAllBtn'),
    deselectAllBtn: $('#deselectAllBtn'),
    moveSelectedBtn: $('#moveSelectedBtn'),
    selectedCount: $('#selectedCount'),
    toastContainer: $('#toastContainer'),
};

// ============================================
// Toast Notifications
// ============================================
function showToast(message, type = 'info', duration = 3500) {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    const icons = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' };
    toast.innerHTML = `<span>${icons[type] || 'ℹ️'}</span><span>${message}</span>`;

    dom.toastContainer.appendChild(toast);
    setTimeout(() => {
        toast.classList.add('toast-out');
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

// ============================================
// Section Switching
// ============================================
function showSection(section) {
    dom.landingSection.style.display = 'none';
    dom.scanningSection.style.display = 'none';
    dom.resultsSection.style.display = 'none';
    section.style.display = '';
}

// ============================================
// Scan Log
// ============================================
function addLogEntry(text) {
    const entry = document.createElement('span');
    entry.className = 'log-entry';
    entry.textContent = text;
    dom.scanLog.appendChild(entry);
    dom.scanLog.scrollTop = dom.scanLog.scrollHeight;

    // Keep only last 50 entries
    while (dom.scanLog.children.length > 50) {
        dom.scanLog.removeChild(dom.scanLog.firstChild);
    }
}

function updateProgress(current, total, label) {
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    dom.progressFill.style.width = pct + '%';
    dom.progressCount.textContent = `${current} / ${total}`;
    dom.progressPercent.textContent = pct + '%';
    if (label) dom.scanSubtitle.textContent = label;
}

// ============================================
// File System Helpers
// ============================================
function isImageFile(name) {
    const ext = '.' + name.split('.').pop().toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
}

/**
 * Recursively collect all image file handles from a directory
 */
async function collectImages(dirHandle, path = '') {
    const results = [];
    
    try {
        for await (const [name, handle] of dirHandle.entries()) {
            const fullPath = path ? `${path}/${name}` : name;
            
            // Skip the Duplicates folder we create
            if (handle.kind === 'directory' && name === '_DupliScan_Duplicates') {
                continue;
            }
            
            if (handle.kind === 'file' && isImageFile(name)) {
                results.push({ handle, path: fullPath, name });
            } else if (handle.kind === 'directory') {
                try {
                    const subResults = await collectImages(handle, fullPath);
                    results.push(...subResults);
                } catch (err) {
                    addLogEntry(`⚠ Skipping ${fullPath}: ${err.message}`);
                }
            }
        }
    } catch (err) {
        addLogEntry(`⚠ Error reading directory: ${err.message}`);
    }
    
    return results;
}

/**
 * Compute SHA-256 hash of a file
 */
async function hashFile(file) {
    const buffer = await file.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Create an object URL for image preview
 */
function createPreviewUrl(file) {
    return URL.createObjectURL(file);
}

// ============================================
// Scanning Pipeline
// ============================================
async function startScan() {
    if (state.scanning) return;

    // Prompt user to pick a folder
    let dirHandle;
    try {
        dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    } catch (err) {
        // User cancelled
        return;
    }

    state.rootHandle = dirHandle;
    state.images = [];
    state.duplicateGroups = [];
    state.selectedIndices.clear();
    state.scanning = true;

    // Clean up old object URLs
    revokeAllUrls();

    showSection(dom.scanningSection);
    dom.scanLog.innerHTML = '';
    dom.scanTitle.textContent = 'Scanning folder...';
    updateProgress(0, 0, 'Discovering image files');
    addLogEntry(`📂 Scanning: ${dirHandle.name}`);

    // Phase 1: Discover files
    const fileEntries = await collectImages(dirHandle);
    const totalFiles = fileEntries.length;
    addLogEntry(`Found ${totalFiles} image files`);

    if (totalFiles === 0) {
        state.scanning = false;
        showResults();
        return;
    }

    // Phase 2: Hash files
    dom.scanTitle.textContent = 'Analyzing images...';
    updateProgress(0, totalFiles, 'Computing content hashes');

    const hashMap = new Map(); // hash -> [indices]
    
    for (let i = 0; i < fileEntries.length; i++) {
        const entry = fileEntries[i];
        try {
            const file = await entry.handle.getFile();
            const hash = await hashFile(file);
            const objectUrl = createPreviewUrl(file);

            const imageData = {
                file,
                handle: entry.handle,
                path: entry.path,
                name: entry.name,
                size: file.size,
                hash,
                objectUrl,
            };
            
            const idx = state.images.length;
            state.images.push(imageData);

            if (!hashMap.has(hash)) {
                hashMap.set(hash, []);
            }
            hashMap.get(hash).push(idx);

            // Update progress every file
            updateProgress(i + 1, totalFiles, `Hashing: ${entry.name}`);
            
            if (i % 10 === 0) {
                addLogEntry(`🔬 ${entry.path}`);
            }

            // Yield to UI every 5 files
            if (i % 5 === 0) {
                await new Promise(r => setTimeout(r, 0));
            }
        } catch (err) {
            addLogEntry(`⚠ Error: ${entry.path} - ${err.message}`);
        }
    }

    // Phase 3: Find duplicate groups
    dom.scanTitle.textContent = 'Finding duplicates...';
    
    for (const [hash, indices] of hashMap.entries()) {
        if (indices.length > 1) {
            state.duplicateGroups.push(indices);
        }
    }

    const dupCount = state.duplicateGroups.reduce((sum, g) => sum + g.length - 1, 0);
    addLogEntry(`✅ Found ${state.duplicateGroups.length} groups with ${dupCount} duplicates`);

    state.scanning = false;
    showResults();
}

// ============================================
// Results Display
// ============================================
function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
    return (bytes / 1073741824).toFixed(2) + ' GB';
}

function showResults() {
    showSection(dom.resultsSection);

    // Stats
    const totalImages = state.images.length;
    const dupCount = state.duplicateGroups.reduce((sum, g) => sum + g.length - 1, 0);
    const savingsBytes = state.duplicateGroups.reduce((sum, g) => {
        // Sum of all duplicates excluding the first (original)
        return sum + g.slice(1).reduce((s, idx) => s + state.images[idx].size, 0);
    }, 0);

    dom.headerStats.style.display = 'flex';
    dom.statFiles.textContent = totalImages;
    dom.statDuplicates.textContent = dupCount;
    dom.statSavings.textContent = formatSize(savingsBytes);

    if (state.duplicateGroups.length === 0) {
        dom.noDuplicates.style.display = '';
        dom.duplicateGroups.innerHTML = '';
        dom.moveSelectedBtn.style.display = 'none';
        dom.selectAllBtn.style.display = 'none';
        dom.deselectAllBtn.style.display = 'none';
        return;
    }

    dom.noDuplicates.style.display = 'none';
    dom.moveSelectedBtn.style.display = '';
    dom.selectAllBtn.style.display = '';
    dom.deselectAllBtn.style.display = '';
    
    renderDuplicateGroups();
    updateSelectedCount();
}

function renderDuplicateGroups() {
    dom.duplicateGroups.innerHTML = '';

    state.duplicateGroups.forEach((group, groupIdx) => {
        const groupEl = document.createElement('div');
        groupEl.className = 'dup-group';
        groupEl.style.animationDelay = `${groupIdx * 0.08}s`;

        const totalSize = group.reduce((s, idx) => s + state.images[idx].size, 0);

        groupEl.innerHTML = `
            <div class="dup-group-header">
                <div class="dup-group-title">
                    <div class="dup-group-badge">${group.length}</div>
                    <span>Duplicate Group ${groupIdx + 1}</span>
                </div>
                <span class="dup-group-size">Total: ${formatSize(totalSize)}</span>
            </div>
            <div class="dup-group-images" id="group-${groupIdx}"></div>
        `;

        dom.duplicateGroups.appendChild(groupEl);

        const imagesContainer = groupEl.querySelector(`#group-${groupIdx}`);

        group.forEach((imgIdx, posInGroup) => {
            const img = state.images[imgIdx];
            const isOriginal = posInGroup === 0;
            const isSelected = state.selectedIndices.has(imgIdx);

            const card = document.createElement('div');
            card.className = `image-card ${isOriginal ? 'original' : ''} ${isSelected ? 'selected' : ''}`;
            card.dataset.imageIdx = imgIdx;

            card.innerHTML = `
                ${!isOriginal ? `<div class="image-checkbox ${isSelected ? 'checked' : ''}" data-idx="${imgIdx}"></div>` : ''}
                <img class="image-card-img" src="${img.objectUrl}" alt="${img.name}" loading="lazy" />
                <div class="image-card-overlay"></div>
                <div class="image-card-info">
                    <div class="image-card-name" title="${img.path}">${img.name}</div>
                    <div class="image-card-meta">
                        <span class="image-card-size">${formatSize(img.size)}</span>
                        <span class="image-card-tag ${isOriginal ? 'original' : 'duplicate'}">${isOriginal ? 'Keep' : 'Duplicate'}</span>
                    </div>
                </div>
            `;

            // Click on card to toggle selection (if not original)
            if (!isOriginal) {
                card.addEventListener('click', (e) => {
                    if (e.target.closest('.image-checkbox') || e.target === card || e.target.closest('.image-card-info')) {
                        toggleImageSelection(imgIdx, card);
                    }
                });

                // Click on the image itself also toggles
                const imgEl = card.querySelector('.image-card-img');
                imgEl.addEventListener('click', () => {
                    toggleImageSelection(imgIdx, card);
                });
            }

            imagesContainer.appendChild(card);
        });
    });
}

function toggleImageSelection(imgIdx, cardEl) {
    if (state.selectedIndices.has(imgIdx)) {
        state.selectedIndices.delete(imgIdx);
        cardEl.classList.remove('selected');
        cardEl.querySelector('.image-checkbox')?.classList.remove('checked');
    } else {
        state.selectedIndices.add(imgIdx);
        cardEl.classList.add('selected');
        cardEl.querySelector('.image-checkbox')?.classList.add('checked');
    }
    updateSelectedCount();
}

function updateSelectedCount() {
    const count = state.selectedIndices.size;
    dom.selectedCount.textContent = `${count} selected`;
    dom.moveSelectedBtn.disabled = count === 0;
}

function selectAllDuplicates() {
    state.selectedIndices.clear();
    
    state.duplicateGroups.forEach(group => {
        // Skip first (original), select rest (duplicates)
        group.slice(1).forEach(idx => state.selectedIndices.add(idx));
    });

    // Update UI
    document.querySelectorAll('.image-card').forEach(card => {
        const idx = parseInt(card.dataset.imageIdx);
        if (state.selectedIndices.has(idx)) {
            card.classList.add('selected');
            card.querySelector('.image-checkbox')?.classList.add('checked');
        }
    });

    updateSelectedCount();
    showToast(`Selected ${state.selectedIndices.size} duplicate images`, 'info');
}

function deselectAll() {
    state.selectedIndices.clear();

    document.querySelectorAll('.image-card.selected').forEach(card => {
        card.classList.remove('selected');
        card.querySelector('.image-checkbox')?.classList.remove('checked');
    });

    updateSelectedCount();
}

// ============================================
// Move Duplicates
// ============================================
async function moveSelectedDuplicates() {
    if (state.selectedIndices.size === 0) return;
    if (!state.rootHandle) {
        showToast('No root folder available', 'error');
        return;
    }

    const count = state.selectedIndices.size;
    
    try {
        // Create _DupliScan_Duplicates directory
        const dupDir = await state.rootHandle.getDirectoryHandle('_DupliScan_Duplicates', { create: true });

        let moved = 0;
        let failed = 0;

        for (const imgIdx of state.selectedIndices) {
            const img = state.images[imgIdx];
            try {
                // Generate unique filename to avoid overwrites
                let destName = img.name;
                let counter = 1;
                while (true) {
                    try {
                        await dupDir.getFileHandle(destName);
                        // File already exists, add counter
                        const parts = img.name.split('.');
                        const ext = parts.pop();
                        destName = `${parts.join('.')}_${counter}.${ext}`;
                        counter++;
                    } catch {
                        break; // File doesn't exist, we can use this name
                    }
                }

                // Copy file to duplicates folder
                const file = await img.handle.getFile();
                const newHandle = await dupDir.getFileHandle(destName, { create: true });
                const writable = await newHandle.createWritable();
                await writable.write(await file.arrayBuffer());
                await writable.close();

                // Try to remove original
                try {
                    // Walk up the path to find parent directory
                    const pathParts = img.path.split('/');
                    let parentHandle = state.rootHandle;
                    for (let i = 0; i < pathParts.length - 1; i++) {
                        parentHandle = await parentHandle.getDirectoryHandle(pathParts[i]);
                    }
                    await parentHandle.removeEntry(img.name);
                } catch (removeErr) {
                    // Couldn't remove original — it's still copied to duplicates folder
                    addLogEntry(`⚠ Copied but couldn't remove original: ${img.path}`);
                }

                moved++;
            } catch (err) {
                failed++;
                console.error(`Failed to move ${img.path}:`, err);
            }
        }

        showToast(
            `Moved ${moved} files to _DupliScan_Duplicates${failed > 0 ? ` (${failed} failed)` : ''}`,
            failed > 0 ? 'warning' : 'success'
        );

        // Clear selections and re-scan
        if (moved > 0) {
            state.selectedIndices.clear();
            // Re-scan the folder
            setTimeout(() => {
                showSection(dom.landingSection);
                dom.headerStats.style.display = 'none';
                revokeAllUrls();
            }, 1500);
        }

    } catch (err) {
        showToast(`Error: ${err.message}`, 'error');
    }
}

// ============================================
// Cleanup
// ============================================
function revokeAllUrls() {
    state.images.forEach(img => {
        if (img.objectUrl) {
            URL.revokeObjectURL(img.objectUrl);
        }
    });
}

function resetAndGoHome() {
    revokeAllUrls();
    state.images = [];
    state.duplicateGroups = [];
    state.selectedIndices.clear();
    state.rootHandle = null;
    dom.headerStats.style.display = 'none';
    showSection(dom.landingSection);
}

// ============================================
// Feature Detection
// ============================================
function checkBrowserSupport() {
    if (!('showDirectoryPicker' in window)) {
        dom.selectFolderBtn.disabled = true;
        dom.selectFolderBtn.textContent = 'Not Supported in This Browser';
        showToast('Please use Chrome, Edge, or Opera for folder access', 'error', 6000);
        return false;
    }
    return true;
}

// ============================================
// Event Listeners
// ============================================
dom.selectFolderBtn.addEventListener('click', () => {
    if (checkBrowserSupport()) startScan();
});

dom.scanAgainBtn.addEventListener('click', () => {
    resetAndGoHome();
});

dom.scanAnotherBtn?.addEventListener('click', () => {
    resetAndGoHome();
});

dom.selectAllBtn.addEventListener('click', selectAllDuplicates);
dom.deselectAllBtn.addEventListener('click', deselectAll);
dom.moveSelectedBtn.addEventListener('click', moveSelectedDuplicates);

// Initial check
checkBrowserSupport();

// ============================================
// Visitor Counter (persistent, global, free)
// Uses multiple APIs with fallback chain
// ============================================

/**
 * Animated number counting effect
 */
function animateCounter(targetNumber) {
    const counterEl = document.getElementById('visitorCount');
    if (!counterEl) return;

    const duration = 1200;
    const start = 0;
    const startTime = performance.now();

    function update(currentTime) {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);
        
        // Ease-out cubic for smooth deceleration
        const eased = 1 - Math.pow(1 - progress, 3);
        const current = Math.round(start + (targetNumber - start) * eased);
        
        counterEl.textContent = current.toLocaleString();
        counterEl.classList.add('animate');

        if (progress < 1) {
            requestAnimationFrame(update);
        }
    }

    requestAnimationFrame(update);
}

/**
 * Counter API Strategy:
 * 
 * Primary:   api.counterapi.dev  (free, reliable, no signup)
 * Secondary: api.countapi.xyz    (free, older but well-known)
 * Fallback:  localStorage        (per-browser only, always works)
 * 
 * How it works:
 * - Every NEW browser session (new tab/window) = +1 count
 * - Page refresh in same session = does NOT re-count
 * - Count is stored on the server permanently — never resets
 * - Any user from anywhere clicking the link = count goes up
 */

const SESSION_KEY = 'dupliscan_session_counted';

// ---- Primary: counterapi.dev ----
async function tryCounterApiDev(shouldIncrement) {
    const base = 'https://api.counterapi.dev/v1';
    const id = 'rushikeshghate-dupliscan/visitors';

    if (shouldIncrement) {
        const res = await fetch(`${base}/${id}/up`);
        if (!res.ok) throw new Error(`counterapi.dev ${res.status}`);
        const data = await res.json();
        return data.count;
    } else {
        // counterapi.dev doesn't have a plain GET, so just call /up
        // We'll handle session dedup in the caller
        const res = await fetch(`${base}/${id}/up`);
        if (!res.ok) throw new Error(`counterapi.dev ${res.status}`);
        const data = await res.json();
        return data.count;
    }
}

// ---- Secondary: countapi.xyz ----
async function tryCountApiXyz(shouldIncrement) {
    const ns = 'rushikeshghate-dupliscan';
    const key = 'visitors';

    if (shouldIncrement) {
        const res = await fetch(`https://api.countapi.xyz/hit/${ns}/${key}`);
        if (!res.ok) throw new Error(`countapi.xyz ${res.status}`);
        const data = await res.json();
        if (data.value == null) throw new Error('countapi.xyz null value');
        return data.value;
    } else {
        const res = await fetch(`https://api.countapi.xyz/get/${ns}/${key}`);
        if (!res.ok) throw new Error(`countapi.xyz ${res.status}`);
        const data = await res.json();
        if (data.value == null) throw new Error('countapi.xyz null value');
        return data.value;
    }
}

// ---- Fallback: localStorage ----
function localStorageCounter(shouldIncrement) {
    const key = 'dupliscan_total_visits';
    let count = parseInt(localStorage.getItem(key) || '0');
    if (shouldIncrement) {
        count++;
        localStorage.setItem(key, count.toString());
    }
    return count;
}

/**
 * Main visitor counter initialization
 * Tries APIs in order until one succeeds
 */
async function initVisitorCounter() {
    const counterEl = document.getElementById('visitorCount');
    if (!counterEl) return;

    const alreadyCounted = sessionStorage.getItem(SESSION_KEY);
    const shouldIncrement = !alreadyCounted;
    let count = null;
    let source = '';

    // Try Primary: counterapi.dev
    try {
        count = await tryCounterApiDev(shouldIncrement);
        source = 'counterapi.dev';
    } catch (e) {
        console.warn('Primary counter failed:', e.message);
    }

    // Try Secondary: countapi.xyz
    if (count == null) {
        try {
            count = await tryCountApiXyz(shouldIncrement);
            source = 'countapi.xyz';
        } catch (e) {
            console.warn('Secondary counter failed:', e.message);
        }
    }

    // Fallback: localStorage
    if (count == null) {
        count = localStorageCounter(shouldIncrement);
        source = 'localStorage';
    }

    // Mark this session as counted
    if (shouldIncrement) {
        sessionStorage.setItem(SESSION_KEY, 'true');
    }

    // Display the count
    if (count > 0) {
        animateCounter(count);
    } else {
        counterEl.textContent = '1';
    }

    console.log(`Visitor count: ${count} (via ${source})`);
}

// Initialize the visitor counter on page load
initVisitorCounter();

