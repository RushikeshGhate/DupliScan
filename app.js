/**
 * DupliScan - Duplicate File Finder
 *
 * Scans folders with the File System Access API, filters supported extensions,
 * groups by size first for speed, then hashes file content with SHA-256 to find
 * true duplicates. Selected duplicates can be moved into a review folder.
 */

const DEFAULT_EXTENSIONS = [
    '.pdf',
    '.txt',
    '.doc',
    '.docx',
    '.xls',
    '.xlsx',
    '.ppt',
    '.pptx',
];

const FILE_TYPE_META = {
    '.pdf': { label: 'PDF', icon: 'PDF', accent: 'pdf' },
    '.txt': { label: 'TXT', icon: 'TXT', accent: 'txt' },
    '.doc': { label: 'DOC', icon: 'DOC', accent: 'doc' },
    '.docx': { label: 'DOCX', icon: 'DOC', accent: 'doc' },
    '.xls': { label: 'XLS', icon: 'XLS', accent: 'sheet' },
    '.xlsx': { label: 'XLSX', icon: 'XLS', accent: 'sheet' },
    '.ppt': { label: 'PPT', icon: 'PPT', accent: 'slide' },
    '.pptx': { label: 'PPTX', icon: 'PPT', accent: 'slide' },
};

const state = {
    rootHandle: null,
    files: [],
    duplicateGroups: [],
    selectedIndices: new Set(),
    scanning: false,
    selectedExtensions: new Set(DEFAULT_EXTENSIONS),
    totalMatchedFiles: 0,
};

const $ = (sel) => document.querySelector(sel);

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
    filterCheckboxes: Array.from(document.querySelectorAll('.filter-checkbox')),
};

function showToast(message, type = 'info', duration = 3500) {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const icons = {
        success: 'OK',
        error: 'ERR',
        info: 'INFO',
        warning: 'WARN',
    };

    toast.innerHTML = `<span>${icons[type] || 'INFO'}</span><span>${message}</span>`;
    dom.toastContainer.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('toast-out');
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

function showSection(section) {
    dom.landingSection.style.display = 'none';
    dom.scanningSection.style.display = 'none';
    dom.resultsSection.style.display = 'none';
    section.style.display = '';
}

function addLogEntry(text) {
    const entry = document.createElement('span');
    entry.className = 'log-entry';
    entry.textContent = text;
    dom.scanLog.appendChild(entry);
    dom.scanLog.scrollTop = dom.scanLog.scrollHeight;

    while (dom.scanLog.children.length > 50) {
        dom.scanLog.removeChild(dom.scanLog.firstChild);
    }
}

function updateProgress(current, total, label) {
    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    dom.progressFill.style.width = `${pct}%`;
    dom.progressCount.textContent = `${current} / ${total}`;
    dom.progressPercent.textContent = `${pct}%`;

    if (label) {
        dom.scanSubtitle.textContent = label;
    }
}

function getExtension(name) {
    const dotIndex = name.lastIndexOf('.');
    return dotIndex === -1 ? '' : name.slice(dotIndex).toLowerCase();
}

function getSelectedExtensions() {
    return new Set(
        dom.filterCheckboxes
            .filter((checkbox) => checkbox.checked)
            .map((checkbox) => checkbox.value.toLowerCase())
    );
}

function isSupportedFile(name) {
    return state.selectedExtensions.has(getExtension(name));
}

async function collectFiles(dirHandle, path = '') {
    const results = [];

    try {
        for await (const [name, handle] of dirHandle.entries()) {
            const fullPath = path ? `${path}/${name}` : name;

            if (handle.kind === 'directory' && name === '_DupliScan_Duplicates') {
                continue;
            }

            if (handle.kind === 'file' && isSupportedFile(name)) {
                results.push({ handle, path: fullPath, name, extension: getExtension(name) });
            } else if (handle.kind === 'directory') {
                try {
                    const subResults = await collectFiles(handle, fullPath);
                    results.push(...subResults);
                } catch (err) {
                    addLogEntry(`Skipping ${fullPath}: ${err.message}`);
                }
            }
        }
    } catch (err) {
        addLogEntry(`Error reading directory: ${err.message}`);
    }

    return results;
}

async function hashFile(file) {
    const buffer = await file.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
    return `${(bytes / 1073741824).toFixed(2)} GB`;
}

function getFileMeta(extension) {
    return FILE_TYPE_META[extension] || { label: extension.replace('.', '').toUpperCase() || 'FILE', icon: 'FILE', accent: 'default' };
}

async function startScan() {
    if (state.scanning) return;

    state.selectedExtensions = getSelectedExtensions();
    if (state.selectedExtensions.size === 0) {
        showToast('Select at least one file type before scanning.', 'warning');
        return;
    }

    let dirHandle;
    try {
        dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    } catch {
        return;
    }

    state.rootHandle = dirHandle;
    state.files = [];
    state.duplicateGroups = [];
    state.selectedIndices.clear();
    state.scanning = true;
    state.totalMatchedFiles = 0;

    showSection(dom.scanningSection);
    dom.scanLog.innerHTML = '';
    dom.scanTitle.textContent = 'Scanning folder...';
    updateProgress(0, 0, 'Discovering matching files');
    addLogEntry(`Scanning: ${dirHandle.name}`);
    addLogEntry(`Filters: ${Array.from(state.selectedExtensions).join(', ')}`);

    const fileEntries = await collectFiles(dirHandle);
    state.totalMatchedFiles = fileEntries.length;
    addLogEntry(`Found ${fileEntries.length} matching files`);

    if (fileEntries.length === 0) {
        state.scanning = false;
        showResults();
        return;
    }

    dom.scanTitle.textContent = 'Grouping files...';
    updateProgress(0, fileEntries.length, 'Reading file sizes');

    const sizeBuckets = new Map();
    for (let i = 0; i < fileEntries.length; i++) {
        const entry = fileEntries[i];
        try {
            const file = await entry.handle.getFile();
            entry.file = file;
            entry.size = file.size;

            if (!sizeBuckets.has(file.size)) {
                sizeBuckets.set(file.size, []);
            }
            sizeBuckets.get(file.size).push(entry);
            updateProgress(i + 1, fileEntries.length, `Sizing: ${entry.name}`);
        } catch (err) {
            addLogEntry(`Error reading ${entry.path}: ${err.message}`);
        }
    }

    const candidates = [];
    for (const entries of sizeBuckets.values()) {
        if (entries.length > 1) {
            candidates.push(...entries);
        }
    }

    addLogEntry(`${candidates.length} files need content hashing`);

    if (candidates.length === 0) {
        state.scanning = false;
        showResults();
        return;
    }

    dom.scanTitle.textContent = 'Analyzing files...';
    updateProgress(0, candidates.length, 'Computing content hashes');

    const hashMap = new Map();
    for (let i = 0; i < candidates.length; i++) {
        const entry = candidates[i];
        try {
            const hash = await hashFile(entry.file);
            const fileData = {
                file: entry.file,
                handle: entry.handle,
                path: entry.path,
                name: entry.name,
                size: entry.size,
                extension: entry.extension,
                hash,
            };

            const idx = state.files.length;
            state.files.push(fileData);

            if (!hashMap.has(hash)) {
                hashMap.set(hash, []);
            }
            hashMap.get(hash).push(idx);

            updateProgress(i + 1, candidates.length, `Hashing: ${entry.name}`);
            if (i % 8 === 0) {
                addLogEntry(`Hashing ${entry.path}`);
                await new Promise((resolve) => setTimeout(resolve, 0));
            }
        } catch (err) {
            addLogEntry(`Error hashing ${entry.path}: ${err.message}`);
        }
    }

    dom.scanTitle.textContent = 'Finding duplicates...';
    for (const indices of hashMap.values()) {
        if (indices.length > 1) {
            state.duplicateGroups.push(indices);
        }
    }

    const duplicateCount = state.duplicateGroups.reduce((sum, group) => sum + group.length - 1, 0);
    addLogEntry(`Done: ${state.duplicateGroups.length} groups, ${duplicateCount} duplicates`);

    state.scanning = false;
    showResults();
}

function showResults() {
    showSection(dom.resultsSection);

    const duplicateCount = state.duplicateGroups.reduce((sum, group) => sum + group.length - 1, 0);
    const savingsBytes = state.duplicateGroups.reduce((sum, group) => (
        sum + group.slice(1).reduce((groupSum, idx) => groupSum + state.files[idx].size, 0)
    ), 0);

    dom.headerStats.style.display = 'flex';
    dom.statFiles.textContent = state.totalMatchedFiles;
    dom.statDuplicates.textContent = duplicateCount;
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
        const totalSize = group.reduce((sum, idx) => sum + state.files[idx].size, 0);
        const groupEl = document.createElement('div');
        groupEl.className = 'dup-group';
        groupEl.style.animationDelay = `${groupIdx * 0.08}s`;
        groupEl.innerHTML = `
            <div class="dup-group-header">
                <div class="dup-group-title">
                    <div class="dup-group-badge">${group.length}</div>
                    <span>Duplicate Group ${groupIdx + 1}</span>
                </div>
                <span class="dup-group-size">Total: ${formatSize(totalSize)}</span>
            </div>
            <div class="dup-group-files" id="group-${groupIdx}"></div>
        `;

        dom.duplicateGroups.appendChild(groupEl);

        const filesContainer = groupEl.querySelector(`#group-${groupIdx}`);
        group.forEach((fileIdx, position) => {
            const file = state.files[fileIdx];
            const fileMeta = getFileMeta(file.extension);
            const isOriginal = position === 0;
            const isSelected = state.selectedIndices.has(fileIdx);

            const card = document.createElement('div');
            card.className = `file-card ${isOriginal ? 'original' : ''} ${isSelected ? 'selected' : ''}`;
            card.dataset.fileIdx = fileIdx;
            card.innerHTML = `
                ${!isOriginal ? `<div class="file-checkbox ${isSelected ? 'checked' : ''}" data-idx="${fileIdx}"></div>` : ''}
                <div class="file-card-top">
                    <div class="file-badge ${fileMeta.accent}">${fileMeta.icon}</div>
                    <div class="file-card-title-wrap">
                        <div class="file-card-name" title="${file.path}">${file.name}</div>
                        <div class="file-card-path" title="${file.path}">${file.path}</div>
                    </div>
                </div>
                <div class="file-card-meta">
                    <span>${formatSize(file.size)}</span>
                    <span>${fileMeta.label}</span>
                    <span class="file-card-tag ${isOriginal ? 'original' : 'duplicate'}">${isOriginal ? 'Keep' : 'Duplicate'}</span>
                </div>
            `;

            if (!isOriginal) {
                card.addEventListener('click', (event) => {
                    if (event.target.closest('.file-checkbox') || event.target === card || event.target.closest('.file-card-top') || event.target.closest('.file-card-meta')) {
                        toggleFileSelection(fileIdx, card);
                    }
                });
            }

            filesContainer.appendChild(card);
        });
    });
}

function toggleFileSelection(fileIdx, cardEl) {
    if (state.selectedIndices.has(fileIdx)) {
        state.selectedIndices.delete(fileIdx);
        cardEl.classList.remove('selected');
        cardEl.querySelector('.file-checkbox')?.classList.remove('checked');
    } else {
        state.selectedIndices.add(fileIdx);
        cardEl.classList.add('selected');
        cardEl.querySelector('.file-checkbox')?.classList.add('checked');
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
    state.duplicateGroups.forEach((group) => {
        group.slice(1).forEach((idx) => state.selectedIndices.add(idx));
    });

    document.querySelectorAll('.file-card').forEach((card) => {
        const idx = Number(card.dataset.fileIdx);
        if (state.selectedIndices.has(idx)) {
            card.classList.add('selected');
            card.querySelector('.file-checkbox')?.classList.add('checked');
        }
    });

    updateSelectedCount();
    showToast(`Selected ${state.selectedIndices.size} duplicate files`, 'info');
}

function deselectAll() {
    state.selectedIndices.clear();
    document.querySelectorAll('.file-card.selected').forEach((card) => {
        card.classList.remove('selected');
        card.querySelector('.file-checkbox')?.classList.remove('checked');
    });
    updateSelectedCount();
}

async function moveSelectedDuplicates() {
    if (state.selectedIndices.size === 0 || !state.rootHandle) {
        return;
    }

    try {
        const dupDir = await state.rootHandle.getDirectoryHandle('_DupliScan_Duplicates', { create: true });
        let moved = 0;
        let failed = 0;

        for (const fileIdx of state.selectedIndices) {
            const fileEntry = state.files[fileIdx];
            try {
                let destName = fileEntry.name;
                let counter = 1;

                while (true) {
                    try {
                        await dupDir.getFileHandle(destName);
                        const dotIndex = fileEntry.name.lastIndexOf('.');
                        const baseName = dotIndex === -1 ? fileEntry.name : fileEntry.name.slice(0, dotIndex);
                        const ext = dotIndex === -1 ? '' : fileEntry.name.slice(dotIndex);
                        destName = `${baseName}_${counter}${ext}`;
                        counter++;
                    } catch {
                        break;
                    }
                }

                const newHandle = await dupDir.getFileHandle(destName, { create: true });
                const writable = await newHandle.createWritable();
                await writable.write(await fileEntry.file.arrayBuffer());
                await writable.close();

                try {
                    const pathParts = fileEntry.path.split('/');
                    let parentHandle = state.rootHandle;
                    for (let i = 0; i < pathParts.length - 1; i++) {
                        parentHandle = await parentHandle.getDirectoryHandle(pathParts[i]);
                    }
                    await parentHandle.removeEntry(fileEntry.name);
                } catch (removeErr) {
                    addLogEntry(`Copied but could not remove original: ${fileEntry.path}`);
                }

                moved++;
            } catch (err) {
                failed++;
                addLogEntry(`Move failed: ${fileEntry.path} (${err.message})`);
            }
        }

        showToast(
            `Moved ${moved} files to _DupliScan_Duplicates${failed ? ` (${failed} failed)` : ''}`,
            failed ? 'warning' : 'success'
        );

        if (moved > 0) {
            state.selectedIndices.clear();
            setTimeout(() => {
                resetAndGoHome();
            }, 1500);
        }
    } catch (err) {
        showToast(`Error: ${err.message}`, 'error');
    }
}

function resetAndGoHome() {
    state.files = [];
    state.duplicateGroups = [];
    state.selectedIndices.clear();
    state.rootHandle = null;
    state.totalMatchedFiles = 0;
    dom.headerStats.style.display = 'none';
    showSection(dom.landingSection);
}

function checkBrowserSupport() {
    if (!('showDirectoryPicker' in window)) {
        dom.selectFolderBtn.disabled = true;
        dom.selectFolderBtn.textContent = 'Not Supported in This Browser';
        showToast('Please use Chrome, Edge, or Opera for folder access.', 'error', 6000);
        return false;
    }

    return true;
}

function animateCounter(targetNumber) {
    const counterEl = document.getElementById('visitorCount');
    if (!counterEl) return;

    const duration = 1200;
    const startTime = performance.now();

    function update(currentTime) {
        const progress = Math.min((currentTime - startTime) / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        counterEl.textContent = Math.round(targetNumber * eased).toLocaleString();

        if (progress < 1) {
            requestAnimationFrame(update);
        }
    }

    requestAnimationFrame(update);
}

const SESSION_KEY = 'dupliscan_session_counted';

async function tryCounterApiDev(shouldIncrement) {
    const base = 'https://api.counterapi.dev/v1';
    const id = 'rushikeshghate-dupliscan/visitors';
    const endpoint = shouldIncrement ? 'up' : 'up';
    const res = await fetch(`${base}/${id}/${endpoint}`);
    if (!res.ok) throw new Error(`counterapi.dev ${res.status}`);
    const data = await res.json();
    return data.count;
}

async function tryCountApiXyz(shouldIncrement) {
    const ns = 'rushikeshghate-dupliscan';
    const key = 'visitors';
    const url = shouldIncrement
        ? `https://api.countapi.xyz/hit/${ns}/${key}`
        : `https://api.countapi.xyz/get/${ns}/${key}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`countapi.xyz ${res.status}`);
    const data = await res.json();
    if (data.value == null) throw new Error('countapi.xyz null value');
    return data.value;
}

function localStorageCounter(shouldIncrement) {
    const key = 'dupliscan_total_visits';
    let count = Number.parseInt(localStorage.getItem(key) || '0', 10);

    if (shouldIncrement) {
        count++;
        localStorage.setItem(key, String(count));
    }

    return count;
}

async function initVisitorCounter() {
    const counterEl = document.getElementById('visitorCount');
    if (!counterEl) return;

    const alreadyCounted = sessionStorage.getItem(SESSION_KEY);
    const shouldIncrement = !alreadyCounted;
    let count = null;

    try {
        count = await tryCounterApiDev(shouldIncrement);
    } catch {
        try {
            count = await tryCountApiXyz(shouldIncrement);
        } catch {
            count = localStorageCounter(shouldIncrement);
        }
    }

    if (shouldIncrement) {
        sessionStorage.setItem(SESSION_KEY, 'true');
    }

    if (count > 0) {
        animateCounter(count);
    } else {
        counterEl.textContent = '1';
    }
}

dom.filterCheckboxes.forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
        const checkedCount = dom.filterCheckboxes.filter((item) => item.checked).length;
        if (checkedCount === 0) {
            checkbox.checked = true;
            showToast('At least one file type must stay selected.', 'warning');
        }
    });
});

dom.selectFolderBtn.addEventListener('click', () => {
    if (checkBrowserSupport()) {
        startScan();
    }
});

dom.scanAgainBtn.addEventListener('click', resetAndGoHome);
dom.scanAnotherBtn?.addEventListener('click', resetAndGoHome);
dom.selectAllBtn.addEventListener('click', selectAllDuplicates);
dom.deselectAllBtn.addEventListener('click', deselectAll);
dom.moveSelectedBtn.addEventListener('click', moveSelectedDuplicates);

checkBrowserSupport();
initVisitorCounter();
