const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

const SVN_WORKING_FOLDER = "";

/* ------------------------------ ACTIVATE -------------------------------- */

function activate(context) {
    const storageFile = path.join(context.globalStorageUri.fsPath, "revisions.json");

    ensureStorageFolderExists(context.globalStorageUri.fsPath);

    const provider = new MyTreeDataProvider(context);
    provider.load();

    vscode.window.createTreeView("svnRevisionManagerView", {
        treeDataProvider: provider
    });

    updateDataPathDescription(context);

    vscode.window.showInformationMessage(
        `SVN Revision Manager default data location: ${context.globalStorageUri.fsPath}`
    );

    /* -------------------- COMMAND: ADD GROUP -------------------- */
    context.subscriptions.push(
        vscode.commands.registerCommand("svnRevisionManager.addGroup", async () => {
            const groupName = await vscode.window.showInputBox({
                prompt: "Enter group name",
                placeHolder: "e.g., Bug Fixes"
            });

            if (!groupName) return;

            provider.addGroup(groupName);
        })
    );

    /* -------------------- COMMAND: DELETE GROUP -------------------- */
    context.subscriptions.push(
        vscode.commands.registerCommand("svnRevisionManager.deleteGroup", async (item) => {
            const confirm = await vscode.window.showWarningMessage(
                `Delete group "${item.groupName}" and all its revisions?`,
                { modal: true },
                "Yes"
            );

            if (confirm === "Yes") {
                provider.deleteGroup(item.groupName);
            }
        })
    );

    /* -------------------- COMMAND: RENAME GROUP -------------------- */
    context.subscriptions.push(
        vscode.commands.registerCommand("svnRevisionManager.renameGroup", async (item) => {
            const oldName = item.groupName;

            const newName = await vscode.window.showInputBox({
                prompt: `Rename group "${oldName}" to:`,
                value: oldName
            });

            if (!newName || !newName.trim()) {
                return;
            }

            provider.renameGroup(oldName, newName.trim());
        })
    );

    /* ----------------- COMMAND: ADD REVISION TO GROUP ---------------- */
    context.subscriptions.push(
        vscode.commands.registerCommand("svnRevisionManager.addRevisionToGroup", async (groupInfo) => {
            if (!groupInfo || !groupInfo.groupName) return;
            provider.addRevisionToGroup(groupInfo.groupName);
        })
    );

    /* ----------------- COMMAND: DELETE REVISION ---------------- */
    context.subscriptions.push(
        vscode.commands.registerCommand("svnRevisionManager.deleteRevision", async (item) => {
            const revision = item.revision;
            const groupName = item.groupName;

            const confirm = await vscode.window.showWarningMessage(
                `Delete revision ${revision}?`,
                { modal: true },
                "Yes"
            );

            if (confirm !== "Yes") return;

            provider.deleteRevision(groupName, revision);
        })
    );

    /* ----------- COMMAND: OPEN ON DOUBLE CLICK (file) ----------- */
    context.subscriptions.push(
        vscode.commands.registerCommand("svnRevisionManager.openOnDoubleClick", async (item) => {
            const now = Date.now();

            if (item._lastClick && now - item._lastClick < 300) {
                if (item.isFile && item.revision) {
                    const rev = item.revision;
                    const file = item.filePath;

                    try {
                        const patch = await runSvnDiff(rev, file);

                        const doc = await vscode.workspace.openTextDocument({
                            content: patch,
                            language: "diff"
                        });

                        vscode.window.showTextDocument(doc);

                    } catch (err) {
                        vscode.window.showErrorMessage(`Failed to load patch for ${file}: ${err.message}`);
                    }

                    return;
                }
            }

            item._lastClick = now;
        })
    );

    /* ----------- COMMAND: COPY FILENAME ----------- */
    context.subscriptions.push(
        vscode.commands.registerCommand("svnRevisionManager.copyFileName", async (item) => {
            if (!item || !item.filePath) return;

            const fileName = path.basename(item.filePath);

            await vscode.env.clipboard.writeText(fileName);
            vscode.window.showInformationMessage(`Copied filename: ${fileName}`);
        })
    );

    /* ----------- COMMAND: COPY FILEPATH+FILENAME ----------- */
    context.subscriptions.push(
        vscode.commands.registerCommand("svnRevisionManager.copyFilePathFull", async (item) => {
            if (!item || !item.filePath) return;

            await vscode.env.clipboard.writeText(item.filePath);
            vscode.window.showInformationMessage(`Copied: ${item.filePath}`);
        })
    );

    /* ----------- COMMAND: LIST FILEPATH+FILENAME ----------- */
    context.subscriptions.push(
        vscode.commands.registerCommand("svnRevisionManager.generateFileList", async (item) => {
            const groupName = item.groupName;
            if (!groupName) return;

            provider.generateFileList(groupName);
        })
    );

    /* ----------- COMMAND: REFRESH LOCKS SECTION ----------- */
    context.subscriptions.push(
        vscode.commands.registerCommand("svnRevisionManager.refreshLocks", async () => {
            provider.clearLocksCache();
            provider.refresh();
        })
    );

    // Register lock file command
    let lockFileDisposable = vscode.commands.registerCommand('svnRevisionManager.lockFile', async (node) => {
        let filePath;

        if (node instanceof vscode.Uri) {
            const workingFolder = getWorkingFolder();
            filePath = path.relative(workingFolder, node.fsPath);
        } else if (node && (node.contextValue === 'file' || node.contextValue === 'lockedFile')) {
            filePath = node.filePath;
        } else {
            vscode.window.showErrorMessage('Please select a file.');
            return;
        }

        await lockFile(filePath, false);
    });

    // Register force lock file command
    let forceLockFileDisposable = vscode.commands.registerCommand('svnRevisionManager.forceLockFile', async (node) => {
        let filePath;
        let fileName;

        if (node instanceof vscode.Uri) {
            const workingFolder = getWorkingFolder();
            filePath = path.relative(workingFolder, node.fsPath);
            fileName = path.basename(node.fsPath);
        } else if (node && (node.contextValue === 'file' || node.contextValue === 'lockedFile')) {
            filePath = node.filePath;
            fileName = node.label;
        } else {
            vscode.window.showErrorMessage('Please select a file.');
            return;
        }

        const confirm = await vscode.window.showWarningMessage(
            `Force lock "${fileName}"? This will steal the lock from another user.`,
            { modal: true },
            'Yes', 'No'
        );

        if (confirm === 'Yes') {
            await lockFile(filePath, true);
        }
    });

    // Register unlock file command
    let unlockFileDisposable = vscode.commands.registerCommand('svnRevisionManager.unlockFile', async (node) => {
        let filePath;

        if (node instanceof vscode.Uri) {
            const workingFolder = getWorkingFolder();
            filePath = path.relative(workingFolder, node.fsPath);
        } else if (node && (node.contextValue === 'file' || node.contextValue === 'lockedFile')) {
            filePath = node.filePath;
        } else {
            vscode.window.showErrorMessage('Please select a file.');
            return;
        }

        await unlockFile(filePath);
    });

    context.subscriptions.push(lockFileDisposable);
    context.subscriptions.push(forceLockFileDisposable);
    context.subscriptions.push(unlockFileDisposable);

    /* ----------- COMMAND: REVERT FILE ----------- */
    context.subscriptions.push(
        vscode.commands.registerCommand('svnRevisionManager.revertFile', async (node) => {
            let filePath;
            if (node instanceof vscode.Uri) {
                const workingFolder = getWorkingFolder();
                filePath = path.relative(workingFolder, node.fsPath);
            } else if (node && (node.contextValue === 'file' || node.contextValue === 'lockedFile')) {
                filePath = node.filePath;
            } else {
                vscode.window.showErrorMessage('Please select a file.');
                return;
            }

            const confirm = await vscode.window.showWarningMessage(
                `Revert all local changes to "${path.basename(filePath)}"? This cannot be undone.`,
                { modal: true },
                'Yes', 'No'
            );

            if (confirm !== 'Yes') return;

            const workingFolder = getWorkingFolderSafe();
            const svnPath = getSvnPath();
            if (!workingFolder || !svnPath) {
                vscode.window.showErrorMessage('SVN working folder or svn path not configured.');
                return;
            }

            const fullPath = path.join(workingFolder, filePath);
            exec(`"${svnPath}" revert "${fullPath}"`, { cwd: workingFolder }, (error, stdout, stderr) => {
                if (error) {
                    vscode.window.showErrorMessage(`Revert failed: ${stderr || error.message}`);
                    return;
                }
                vscode.window.showInformationMessage(`Reverted: ${path.basename(filePath)}`);
                decorationProvider.refreshAll();
                provider.clearLocksCache();
                provider.refresh();
            });
        })
    );

    /* ----------- COMMAND: SHOW SVN INFO ----------- */
    context.subscriptions.push(
        vscode.commands.registerCommand('svnRevisionManager.infoFile', async (node) => {
            let filePath;
            if (node instanceof vscode.Uri) {
                const workingFolder = getWorkingFolder();
                filePath = path.relative(workingFolder, node.fsPath);
            } else if (node && (node.contextValue === 'file' || node.contextValue === 'lockedFile')) {
                filePath = node.filePath;
            } else {
                vscode.window.showErrorMessage('Please select a file.');
                return;
            }

            const workingFolder = getWorkingFolderSafe();
            const svnPath = getSvnPath();
            if (!workingFolder || !svnPath) {
                vscode.window.showErrorMessage('SVN working folder or svn path not configured.');
                return;
            }

            try {
                const fullPath = path.join(workingFolder, filePath);
                const { stdout } = await execAsync(`"${svnPath}" info "${fullPath}"`, { cwd: workingFolder });
                const doc = await vscode.workspace.openTextDocument({
                    content: stdout || 'No svn info output',
                    language: 'plaintext'
                });
                vscode.window.showTextDocument(doc);
            } catch (err) {
                vscode.window.showErrorMessage(`Failed to run svn info: ${err.message || err}`);
            }
        })
    );

    /* ----------- COMMAND: UPDATE FILE ----------- */
    context.subscriptions.push(
        vscode.commands.registerCommand('svnRevisionManager.updateFile', async (node) => {
            let filePath;
            if (node instanceof vscode.Uri) {
                const workingFolder = getWorkingFolder();
                filePath = path.relative(workingFolder, node.fsPath);
            } else if (node && (node.contextValue === 'file' || node.contextValue === 'lockedFile')) {
                filePath = node.filePath;
            } else {
                vscode.window.showErrorMessage('Please select a file.');
                return;
            }

            const workingFolder = getWorkingFolderSafe();
            const svnPath = getSvnPath();
            if (!workingFolder || !svnPath) {
                vscode.window.showErrorMessage('SVN working folder or svn path not configured.');
                return;
            }

            const fullPath = path.join(workingFolder, filePath);
            
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Updating ${path.basename(filePath)}...`,
                cancellable: false
            }, async () => {
                return new Promise((resolve) => {
                    exec(`"${svnPath}" update "${fullPath}"`, { cwd: workingFolder, maxBuffer: 1024 * 1024 * 5 }, (error, stdout, stderr) => {
                        if (error) {
                            vscode.window.showErrorMessage(`Update failed: ${stderr || error.message}`);
                        } else {
                            const out = stdout && stdout.trim() ? stdout.trim() : `Updated: ${path.basename(filePath)}`;
                            vscode.window.showInformationMessage(out.split(/\r?\n/)[0]);
                            decorationProvider.refreshAll();
                            provider.clearLocksCache();
                            provider.refresh();
                        }
                        resolve();
                    });
                });
            });
        })
    );

    // Register decoration provider
    const decorationProvider = new SvnDecorationProvider();
    context.subscriptions.push(vscode.window.registerFileDecorationProvider(decorationProvider));

    // Refresh decorations every 120 seconds
    const interval = setInterval(() => decorationProvider.refreshAll(), 120_000);
    context.subscriptions.push({ dispose: () => clearInterval(interval) });

    // Refresh on save
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(() => decorationProvider.refreshAll()));

    // Initial refresh
    decorationProvider.refreshAll();

    // Status bar: SVN lock owner
    const lockStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    lockStatusBar.tooltip = 'SVN Lock Info';
    context.subscriptions.push(lockStatusBar);

    const updateLockStatusBar = async () => {
        try {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.isUntitled) {
                lockStatusBar.hide();
                return;
            }

            const workingFolder = getWorkingFolderSafe();
            const svnPath = getSvnPath();
            if (!workingFolder || !svnPath) {
                lockStatusBar.hide();
                return;
            }

            const fsPath = editor.document.uri.fsPath;
            if (!fsPath.toLowerCase().startsWith(workingFolder.toLowerCase())) {
                lockStatusBar.hide();
                return;
            }

            // 1) Get URL for this file from local wc
            let localInfoOut = '';
            try {
                const { stdout } = await execAsync(`"${svnPath}" info "${fsPath}"`, { cwd: workingFolder });
                localInfoOut = stdout || '';
            } catch {
                lockStatusBar.hide();
                return;
            }
            const urlMatch = localInfoOut.match(/^\s*URL:\s*(.+)\s*$/mi);
            const fileUrl = urlMatch ? urlMatch[1].trim() : null;
            if (!fileUrl) {
                lockStatusBar.hide();
                return;
            }

            // 2) Query svn info on the URL to get lock owner (server-side)
            let infoOut = '';
            try {
                const { stdout } = await execAsync(`"${svnPath}" info "${fileUrl}"`, { cwd: workingFolder });
                infoOut = stdout || '';
            } catch {
                lockStatusBar.hide();
                return;
            }

            const ownerMatch = infoOut.match(/Lock\s+Owner:\s*(.+)/i);
            const createdMatch = infoOut.match(/Lock\s+Created:\s*(.+)/i);

            if (ownerMatch) {
                const owner = ownerMatch[1].trim();
                const createdRaw = createdMatch ? createdMatch[1].trim() : '';
                const createdShort = createdRaw ? createdRaw.replace(/\s*\(.*\)\s*$/, '').trim() : '';

                lockStatusBar.text = createdShort
                    ? `$(lock) ${owner} @ ${createdShort}`
                    : `$(lock) ${owner}`;
                lockStatusBar.tooltip = createdRaw
                    ? `SVN Lock\nOwner: ${owner}\nCreated: ${createdRaw}`
                    : `SVN Lock\nOwner: ${owner}`;
                lockStatusBar.backgroundColor = undefined;
                lockStatusBar.show();
            } else {
                lockStatusBar.hide();
            }
        } catch {
            lockStatusBar.hide();
        }
    };

    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => updateLockStatusBar()));
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(() => updateLockStatusBar()));
    updateLockStatusBar();

    /* ----------- COMMAND: SHOW LOCK INFO ----------- */
    context.subscriptions.push(
        vscode.commands.registerCommand('svnRevisionManager.showLockInfo', async (node) => {
            if (!node || !node.filePath) {
                vscode.window.showErrorMessage('Please select a locked file.');
                return;
            }

            const root = getWorkingFolderSafe();
            if (!root) {
                vscode.window.showErrorMessage('SVN working folder not configured.');
                return;
            }

            // Show loading message
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Fetching lock info...',
                cancellable: false
            }, async () => {
                const abs = path.join(root, node.filePath);
                const fileUrl = await getUrlForLocalPath(abs, root);

                if (!fileUrl) {
                    vscode.window.showWarningMessage(`Could not get SVN URL for: ${node.filePath}`);
                    return;
                }

                const remoteLock = await getRemoteLockInfoByUrl(fileUrl, root);

                if (remoteLock) {
                    const createdShort = remoteLock.created 
                        ? remoteLock.created.replace(/\s*\(.*\)\s*$/, '').trim() 
                        : '';
                    
                    const message = createdShort
                        ? `Locked by: ${remoteLock.owner} @ ${createdShort}`
                        : `Locked by: ${remoteLock.owner}`;
                    
                    vscode.window.showInformationMessage(message);
                } else {
                    vscode.window.showWarningMessage(`No lock info found for: ${node.filePath}`);
                }
            });
        })
    );
}

/* ------------------------------ TREE ITEM CLASS -------------------------------- */

class MyTreeItem extends vscode.TreeItem {
    constructor({
        label,
        collapsibleState,
        revision = null,
        filePath = null,
        isFile = false,
        isGroup = false,
        groupName = null,

        // New flags:
        isSection = false,
        sectionKey = null,
        isLocksGroup = false,
        locksGroupKey = null,
        isLockedFile = false,
        lockOwner = null,
        lockCreated = null,

        command = null
    }) {
        super(label, collapsibleState);

        this.revision = revision;
        this.filePath = filePath;
        this.isFile = isFile;
        this.isGroup = isGroup;
        this.groupName = groupName;

        this.isSection = isSection;
        this.sectionKey = sectionKey;

        this.isLocksGroup = isLocksGroup;
        this.locksGroupKey = locksGroupKey;

        this.isLockedFile = isLockedFile;
        this.lockOwner = lockOwner;
        this.lockCreated = lockCreated;

        if (isSection) {
            this.contextValue = "section";
            this.iconPath = new vscode.ThemeIcon(sectionKey === "locks" ? "lock" : "list-tree");
            this.command = null;
            return;
        }

        if (isLocksGroup) {
            this.contextValue = "locksGroup";
            this.iconPath = new vscode.ThemeIcon("lock");
            this.command = null;
            return;
        }

        if (isLockedFile) {
            this.contextValue = "lockedFile";
            this.iconPath = new vscode.ThemeIcon("lock");

            if (lockOwner) {
                // "mine" category - we have the info
                const createdShort = lockCreated ? lockCreated.replace(/\s*\(.*\)\s*$/, '').trim() : '';
                this.description = createdShort ? `${lockOwner} @ ${createdShort}` : lockOwner;

                this.tooltip = [
                    `SVN Locked File`,
                    `Path: ${label}`,
                    `Owner: ${lockOwner}`,
                    lockCreated ? `Created: ${lockCreated}` : null
                ].filter(Boolean).join("\n");
            } else {
                // "others" category - no details fetched, show placeholder
                this.description = '';
                this.tooltip = `SVN Locked File\nPath: ${label}\n\nClick "Show Lock Info" to see details`;
            }

            try {
                const workingFolder = getWorkingFolderSafe();
                if (workingFolder && filePath) {
                    const abs = path.join(workingFolder, filePath);
                    this.resourceUri = vscode.Uri.file(abs);
                    this.command = {
                        command: "vscode.open",
                        title: "Open File",
                        arguments: [this.resourceUri]
                    };
                }
            } catch {
                // ignore
            }

            return;
        }

        if (isGroup) {
            this.contextValue = "group";
            this.iconPath = {
                light: vscode.Uri.file(path.join(__dirname, 'media', 'dark-group.svg')),
                dark: vscode.Uri.file(path.join(__dirname, 'media', 'light-group.svg'))
            };
        }

        if (isFile) {
            this.contextValue = "file";
        }
        if (!isGroup && !isFile) {
            this.contextValue = "revision";
        }

        if (!isGroup) {
            this.command = command || {
                title: "Open Diff",
                command: "svnRevisionManager.openOnDoubleClick",
                arguments: [this]
            };
        }
    }
}

/* ------------------------------ SVN HELPERS -------------------------------- */

function getCommitMessage(revision) {
    return new Promise((resolve) => {
        exec(
            `svn log -r ${revision} -l 1`,
            { cwd: getWorkingFolder() },
            (err, stdout) => {
                if (err || !stdout) return resolve("No message");

                const lines = stdout.trim().split("\n");
                const msg = lines[3]?.trim() || "No message";
                resolve(msg);
            }
        );
    });
}

function getChangedFiles(revision) {
    return new Promise((resolve, reject) => {
        exec(
            `"${getSvnPath()}" diff -c ${revision} --summarize`,
            { cwd: getWorkingFolder() },
            (err, stdout) => {
                if (err) return reject(err);

                const files = stdout
                    .split("\n")
                    .map(line => line.trim())
                    .filter(line => line.length > 0)
                    .map(line => {
                        const parts = line.split(/\s+/);
                        return parts[1];
                    });

                resolve(files);
            }
        );
    });
}

function runSvnDiff(revision, filePath = null) {
    let cmd = filePath
        ? `"${getSvnPath()}" diff -c ${revision} "${filePath}"`
        : `"${getSvnPath()}" diff -c ${revision}"`;

    return new Promise((resolve, reject) => {
        exec(
            cmd,
            { cwd: getWorkingFolder(), maxBuffer: 1024 * 1024 * 10 },
            (err, stdout, stderr) => {
                if (err) reject(new Error(stderr || err.message));
                else resolve(stdout || "No diff output");
            }
        );
    });
}

/* ------------------------------ LOCKS -------------------------------- */

function parseSvnStatusShowUpdates(stdout) {
    const lines = (stdout || '').split(/\r?\n/).filter(l => l.trim().length > 0);

    // From `svn status --show-updates` (aka `svn status -u`), the lock flag is at column index 5
    // within the first 7 status columns:
    //   K = locked in this working copy (you hold a lock token)
    //   O = locked by another user/working copy (only shown with -u/--show-updates)
    //   T = lock token present but stolen / mismatched
    //   B = lock token present but broken
    const mineCandidates = new Set();
    const othersCandidates = new Set();

    for (const line of lines) {
        if (/^Status against revision:/i.test(line.trim())) continue;
        if (line.length < 7) continue;

        const flags = line.slice(0, 7);
        const lockFlag = flags[5]; // lock column

        const trimmed = line.trim();
        const parts = trimmed.split(/\s+/);
        const rel = parts[parts.length - 1];

        if (!rel || rel === '.' || rel === '..') continue;

        if (lockFlag === 'K') {
            mineCandidates.add(rel);
        } else if (lockFlag === 'O' || lockFlag === 'T') {
            // Locked by others uses O (and include T)
            othersCandidates.add(rel);
        }
        // Note: per your request, we do NOT include 'B' in "Locked by me" (K-only).
    }

    return {
        mineCandidates: Array.from(mineCandidates),
        othersCandidates: Array.from(othersCandidates)
    };
}

async function getUrlForLocalPath(absPath, root) {
    const svnPath = getSvnPath();
    try {
        const { stdout } = await execAsync(`"${svnPath}" info "${absPath}"`, { cwd: root });
        const m = stdout.match(/^\s*URL:\s*(.+)\s*$/mi);
        return m ? m[1].trim() : null;
    } catch {
        return null;
    }
}

async function getRemoteLockInfoByUrl(fileUrl, cwd) {
    const svnPath = getSvnPath();
    try {
        const { stdout: infoOut } = await execAsync(`"${svnPath}" info "${fileUrl}"`, { cwd });
        const ownerMatch = infoOut.match(/Lock\s+Owner:\s*(.+)/i);
        const createdMatch = infoOut.match(/Lock\s+Created:\s*(.+)/i);

        if (!ownerMatch) return null;

        return {
            owner: ownerMatch[1].trim(),
            created: createdMatch ? createdMatch[1].trim() : ''
        };
    } catch {
        return null;
    }
}

async function getWorkingCopyLocks() {
    const root = getWorkingFolderSafe();
    const svnPath = getSvnPath();
    if (!root || !fs.existsSync(root)) return [];

    let statusOut = '';
    try {
        const { stdout } = await execAsync(`"${svnPath}" status --show-updates --ignore-externals`, { cwd: root });
        statusOut = stdout || '';
    } catch {
        try {
            const { stdout } = await execAsync(`"${svnPath}" status -u --ignore-externals`, { cwd: root });
            statusOut = stdout || '';
        } catch {
            return [];
        }
    }

    const { mineCandidates, othersCandidates } = parseSvnStatusShowUpdates(statusOut);

    const locks = [];

    // For "mine" locks - fetch details (usually small count, and we need to show them)
    for (const rel of mineCandidates) {
        const abs = path.join(root, rel);
        const fileUrl = await getUrlForLocalPath(abs, root);
        if (!fileUrl) continue;

        const remoteLock = await getRemoteLockInfoByUrl(fileUrl, root);
        if (!remoteLock) continue;

        locks.push({
            relPath: rel.replace(/\\/g, '/'),
            owner: remoteLock.owner,
            created: remoteLock.created,
            category: 'mine'
        });
    }

    // For "others" locks - do NOT fetch details (slow), just add the path
    for (const rel of othersCandidates) {
        locks.push({
            relPath: rel.replace(/\\/g, '/'),
            owner: null,      // Will be fetched on demand
            created: null,    // Will be fetched on demand
            category: 'others'
        });
    }

    const uniq = new Map();
    for (const l of locks) {
        if (!uniq.has(l.relPath)) uniq.set(l.relPath, l);
    }

    return Array.from(uniq.values()).sort((a, b) =>
        (a.category || '').localeCompare(b.category || '') ||
        a.relPath.localeCompare(b.relPath)
    );
}

function getLocalUsernameGuess() {
    const cfg = vscode.workspace.getConfiguration("svnRevisionGroup");
    const explicit = cfg.get("username");
    if (explicit && String(explicit).trim()) return String(explicit).trim();

    return (
        process.env.SVN_USERNAME ||
        process.env.USERNAME ||
        process.env.USER ||
        (os.userInfo ? os.userInfo().username : null) ||
        ''
    );
}

/* ------------------------------ PROVIDER -------------------------------- */

class MyTreeDataProvider {
    constructor(context) {
        this.context = context;
        this.groups = {};
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;

        this._locksCache = null;
        this._locksCacheAt = 0;
    }

    load() {
        const filePath = getDataFilePath(this.context);

        try {
            if (fs.existsSync(filePath)) {
                const content = fs.readFileSync(filePath, "utf8");
                this.groups = JSON.parse(content);
            }
        } catch (err) {
            vscode.window.showErrorMessage("Failed to load extension data: " + err.message);
            this.groups = {};
        }
    }

    save() {
        const filePath = getDataFilePath(this.context);

        try {
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, JSON.stringify(this.groups, null, 2), "utf8");
        } catch (err) {
            vscode.window.showErrorMessage("Failed to save extension data: " + err.message);
        }
    }

    addGroup(name) {
        if (!this.groups[name]) {
            this.groups[name] = [];
            this.save();
            this.refresh();
        }
    }

    deleteGroup(name) {
        delete this.groups[name];
        this.save();
        this.refresh();
    }

    renameGroup(oldName, newName) {
        if (!this.groups[oldName]) return;

        this.groups[newName] = this.groups[oldName];
        delete this.groups[oldName];

        this.save();
        this.refresh();
    }

    async addRevisionToGroup(groupName) {
        const revision = await vscode.window.showInputBox({
            prompt: "Enter SVN revision number",
            validateInput: value => {
                if (!value || !/^\d+$/.test(value)) return "Revision must be numeric";
                return null;
            }
        });

        if (!revision) return;

        const existing = this.groups[groupName].some(
            r => String(r.revision) === String(revision)
        );

        if (existing) {
            vscode.window.showWarningMessage(
                `Revision ${revision} already exists in group "${groupName}".`
            );
            return;
        }

        const message = await getCommitMessage(revision);

        this.groups[groupName].push({
            revision: revision,
            message: message
        });

        this.groups[groupName].sort((a, b) => Number(b.revision) - Number(a.revision));

        this.save();
        this.refresh();
    }

    deleteRevision(groupName, revision) {
        if (!this.groups[groupName]) return;

        this.groups[groupName] = this.groups[groupName].filter(
            r => r.revision !== revision
        );

        this.save();
        this.refresh();
    }

    refresh() {
        this._onDidChangeTreeData.fire();
    }

    clearLocksCache() {
        this._locksCache = null;
        this._locksCacheAt = 0;
    }

    getTreeItem(element) {
        return element;
    }

    async _getLocksCached() {
        const now = Date.now();
        if (this._locksCache && (now - this._locksCacheAt) < 30_000) {
            return this._locksCache;
        }

        const locks = await getWorkingCopyLocks();
        this._locksCache = locks;
        this._locksCacheAt = now;
        return locks;
    }

    async getChildren(element) {
        if (!element) {
            return [
                new MyTreeItem({
                    label: "Revisions",
                    collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
                    isSection: true,
                    sectionKey: "revisions"
                }),
                new MyTreeItem({
                    label: "Locks",
                    collapsibleState: vscode.TreeItemCollapsibleState.Expanded,
                    isSection: true,
                    sectionKey: "locks"
                })
            ];
        }

        // SECTION: REVISIONS
        if (element.isSection && element.sectionKey === "revisions") {
            return Object.keys(this.groups).map(groupName =>
                new MyTreeItem({
                    label: groupName,
                    collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
                    isGroup: true,
                    groupName
                })
            );
        }

        // SECTION: LOCKS
if (element.isSection && element.sectionKey === "locks") {
    const locks = await this._getLocksCached();

    const mine = locks.filter(l => l.category === 'mine');
    const others = locks.filter(l => l.category === 'others');

    return [
        new MyTreeItem({
            label: `Locked by me (${mine.length})`,
            collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
            isLocksGroup: true,
            locksGroupKey: "mine"
        }),
        new MyTreeItem({
            label: `Locked by others (${others.length})`,
            collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
            isLocksGroup: true,
            locksGroupKey: "others"
        })
    ];
}

        // LOCKS GROUP: MINE
if (element.isLocksGroup && element.locksGroupKey === "mine") {
    const locks = await this._getLocksCached();
    const mine = locks.filter(l => l.category === 'mine');

    return mine.map(l => new MyTreeItem({
        label: l.relPath,
        collapsibleState: vscode.TreeItemCollapsibleState.None,
        isLockedFile: true,
        filePath: l.relPath,
        lockOwner: l.owner,
        lockCreated: l.created
    }));
}

        // LOCKS GROUP: OTHERS (flat list)
if (element.isLocksGroup && element.locksGroupKey === "others") {
    const locks = await this._getLocksCached();
    const others = locks.filter(l => l.category === 'others');

    return others.map(l => new MyTreeItem({
        label: l.relPath,
        collapsibleState: vscode.TreeItemCollapsibleState.None,
        isLockedFile: true,
        filePath: l.relPath,
        lockOwner: l.owner,
        lockCreated: l.created
    }));
}

        // GROUP LEVEL → SHOW "+ Add Revision" + revisions
        if (element.isGroup) {
            const groupName = element.label;
            const revisions = this.groups[groupName] || [];

            revisions.sort((a, b) => Number(b.revision) - Number(a.revision));

            const children = [];

            children.push(
                new MyTreeItem({
                    label: "+ Add Revision",
                    collapsibleState: vscode.TreeItemCollapsibleState.None,
                    isGroup: false,
                    groupName,
                    command: {
                        command: "svnRevisionManager.addRevisionToGroup",
                        title: "Add Revision",
                        arguments: [{ groupName }]
                    }
                })
            );

            children.push(
                ...revisions.map(r =>
                    new MyTreeItem({
                        label: `${r.revision} : ${r.message}`,
                        collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
                        revision: r.revision,
                        isFile: false,
                        groupName
                    })
                )
            );

            return children;
        }

        // REVISION LEVEL → SHOW CHANGED FILES
        if (!element.isFile && !element.isGroup && element.contextValue === "revision") {
            const files = await getChangedFiles(element.revision);

            return files.map(f =>
                new MyTreeItem({
                    label: f,
                    collapsibleState: vscode.TreeItemCollapsibleState.None,
                    revision: element.revision,
                    filePath: f,
                    isFile: true,
                    groupName: element.groupName
                })
            );
        }

        return [];
    }

    async generateFileList(groupName) {
        const revisions = this.groups[groupName] || [];
        const allFiles = new Set();

        for (const rev of revisions) {
            try {
                const files = await getChangedFiles(rev.revision);
                files.forEach(f => allFiles.add(f));
            } catch (err) {
                console.error(`Failed loading files for revision ${rev.revision}`, err);
            }
        }

        const fileList = Array.from(allFiles).sort();
        const textOutput = fileList.join("\n");

        const doc = await vscode.workspace.openTextDocument({
            content: textOutput,
            language: "text"
        });

        vscode.window.showTextDocument(doc);
    }
}

/* ------------------------------ HELPERS -------------------------------- */

function ensureStorageFolderExists(folder) {
    if (!fs.existsSync(folder)) {
        fs.mkdirSync(folder, { recursive: true });
    }
}

function getWorkingFolder() {
    const config = vscode.workspace.getConfiguration("svnRevisionGroup");
    const folder = config.get("workingFolder");

    if (!folder || folder.trim() === "") {
        vscode.window.showErrorMessage(
            "SVN working folder is not set. Please configure it in Settings."
        );
        throw new Error("SVN working folder not set");
    }

    return folder;
}

function getWorkingFolderSafe() {
    try {
        const config = vscode.workspace.getConfiguration("svnRevisionGroup");
        const folder = config.get("workingFolder");
        if (!folder || folder.trim() === "") {
            return null;
        }
        return folder;
    } catch {
        return null;
    }
}

function getSvnPath() {
    const config = vscode.workspace.getConfiguration("svnRevisionGroup");
    const svnPath = config.get("svnPath");

    if (!svnPath || svnPath.trim() === "") {
        return "svn";
    }

    return svnPath;
}

function updateDataPathDescription(context) {
    const defaultPath = context.globalStorageUri.fsPath;
    console.log(`SVN Revision Manager default storage path: ${defaultPath}`);
}

function getDataFilePath(context) {
    const config = vscode.workspace.getConfiguration("svnRevisionGroup");
    const customPath = config.get("dataPath");

    if (customPath && customPath.trim() !== "") {
        return path.join(customPath, "revisions.json");
    }

    return path.join(context.globalStorageUri.fsPath, "revisions.json");
}

// Helper function to lock a file
async function lockFile(filePath, force = false) {
    const config = vscode.workspace.getConfiguration('svnRevisionGroup');
    const workingFolder = config.get('workingFolder');
    const svnPath = config.get('svnPath') || 'svn';

    if (!workingFolder) {
        vscode.window.showErrorMessage('Please set the SVN working folder in settings.');
        return;
    }

    const fullPath = path.join(workingFolder, filePath);

    const message = await vscode.window.showInputBox({
        prompt: 'Enter lock message (optional)',
        placeHolder: 'Lock message'
    });

    if (message === undefined) {
        return;
    }

    const forceFlag = force ? ' --force' : '';
    const messageFlag = message ? ` -m "${message}"` : '';
    const command = `"${svnPath}" lock${forceFlag}${messageFlag} "${fullPath}"`;

    exec(command, { cwd: workingFolder }, (error, stdout, stderr) => {
        if (error) {
            vscode.window.showErrorMessage(`Failed to lock file: ${stderr || error.message}`);
            return;
        }
        vscode.window.showInformationMessage(`Successfully locked: ${path.basename(filePath)}`);
    });
}

// Helper function to unlock a file
async function unlockFile(filePath) {
    const config = vscode.workspace.getConfiguration('svnRevisionGroup');
    const workingFolder = config.get('workingFolder');
    const svnPath = config.get('svnPath') || 'svn';

    if (!workingFolder) {
        vscode.window.showErrorMessage('Please set the SVN working folder in settings.');
        return;
    }

    const fullPath = path.join(workingFolder, filePath);
    const command = `"${svnPath}" unlock "${fullPath}"`;

    exec(command, { cwd: workingFolder }, (error, stdout, stderr) => {
        if (error) {
            vscode.window.showErrorMessage(`Failed to unlock file: ${stderr || error.message}`);
            return;
        }
        vscode.window.showInformationMessage(`Successfully unlocked: ${path.basename(filePath)}`);
    });
}

class SvnDecorationProvider {
    constructor() {
        this._emitter = new vscode.EventEmitter();
        this.onDidChangeFileDecorations = this._emitter.event;
        this._statusCache = new Map();
        this._isRefreshing = false;
    }

    _keyFor(fsPath) {
        return path.normalize(fsPath).toLowerCase();
    }

    provideFileDecoration(uri) {
        const key = this._keyFor(uri.fsPath);
        const entry = this._statusCache.get(key);
        if (!entry) return;

        switch (entry.status) {
            case 'locked': {
                const owner = entry.owner ? ` by ${entry.owner}` : '';
                const createdShort = entry.created ? ` @ ${entry.created.replace(/\s*\(.*\)\s*$/, '').trim()}` : '';
                return {
                    badge: 'L',
                    tooltip: `SVN: Locked${owner}${createdShort}`,
                    color: new vscode.ThemeColor('gitDecoration.ignoredResourceForeground')
                };
            }
            case 'modified':
                return {
                    badge: 'M',
                    tooltip: 'SVN: Modified',
                    color: new vscode.ThemeColor('gitDecoration.modifiedResourceForeground')
                };
            case 'unversioned':
                return {
                    badge: 'U',
                    tooltip: 'SVN: Unversioned',
                    color: new vscode.ThemeColor('gitDecoration.untrackedResourceForeground')
                };
            case 'ignored':
                return {
                    badge: 'I',
                    tooltip: 'SVN: Ignored',
                    color: new vscode.ThemeColor('gitDecoration.ignoredResourceForeground')
                };
            default:
                return;
        }
    }

    async refreshAll() {
        if (this._isRefreshing) return;
        this._isRefreshing = true;
        try {
            const root = getWorkingFolderSafe();
            if (!root || !fs.existsSync(root)) {
                this._statusCache.clear();
                this._emitter.fire(undefined);
                return;
            }

            const statuses = await this._collectStatuses(root);
            this._statusCache = statuses;
            this._emitter.fire(undefined);
        } catch (e) {
            console.error('SVN decorations refresh failed:', e);
            this._statusCache.clear();
            this._emitter.fire(undefined);
        } finally {
            this._isRefreshing = false;
        }
    }

    async _collectStatuses(root) {
        const cache = new Map();
        const svnPath = getSvnPath();
        if (!svnPath) return cache;

        let stdout = '';
        try {
            const result = await execAsync(`"${svnPath}" status --show-updates --ignore-externals`, { cwd: root });
            stdout = result.stdout || '';
        } catch {
            try {
                const result = await execAsync(`"${svnPath}" status -u --ignore-externals`, { cwd: root });
                stdout = result.stdout || '';
            } catch {
                return cache;
            }
        }

        const lines = stdout.split(/\r?\n/).filter(l => l.trim().length > 0);
        const lockCandidates = [];

        for (const line of lines) {
            if (/^Status against revision:/i.test(line.trim())) continue;
            if (line.length < 7) continue;

            const flags = line.slice(0, 7);
            const itemCode = flags[0];
            const lockFlag = flags[5];

            const trimmed = line.trim();
            const parts = trimmed.split(/\s+/);
            const rel = parts[parts.length - 1];
            if (!rel) continue;

            const abs = path.join(root, rel);
            const key = this._keyFor(abs);

            if (itemCode === 'M') cache.set(key, { status: 'modified' });
            else if (itemCode === '?') cache.set(key, { status: 'unversioned' });
            else if (itemCode === 'I') cache.set(key, { status: 'ignored' });

            if (lockFlag === 'K' || lockFlag === 'O' || lockFlag === 'T' || lockFlag === 'B') {
                lockCandidates.push({ rel, abs, key });
            }
        }

        for (const c of lockCandidates) {
            const fileUrl = await getUrlForLocalPath(c.abs, root);
            if (!fileUrl) continue;

            const remoteLock = await getRemoteLockInfoByUrl(fileUrl, root);
            if (!remoteLock) continue;

            const existing = cache.get(c.key);
            if (!existing || existing.status !== 'modified') {
                cache.set(c.key, {
                    status: 'locked',
                    owner: remoteLock.owner,
                    created: remoteLock.created
                });
            }
        }

        return cache;
    }
}

// Utility used by provider
function execAsync(cmd, opts) {
    return new Promise((resolve, reject) => {
        exec(cmd, opts, (error, stdout, stderr) => {
            if (error) reject(error);
            else resolve({ stdout, stderr });
        });
    });
}

function deactivate() {}

module.exports = { activate, deactivate };