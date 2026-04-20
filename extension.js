const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

const SVN_WORKING_FOLDER = "";

/**
 * Returns all configured SVN working folders.
 * Supports both the old single `workingFolder` and new `workingFolders` array.
 * @returns {string[]}
 */
function getAllWorkingFolders() {
    const config = vscode.workspace.getConfiguration('svnRevisionGroup');
    const folders = [];

    // New array setting
    const workingFolders = config.get('workingFolders') || [];
    if (Array.isArray(workingFolders)) {
        for (const f of workingFolders) {
            if (f && typeof f === 'string' && f.trim()) {
                folders.push(f.trim());
            }
        }
    }

    // Backward compatibility: old single setting
    const single = config.get('workingFolder') || '';
    if (single && typeof single === 'string' && single.trim()) {
        const trimmed = single.trim();
        if (!folders.includes(trimmed)) {
            folders.push(trimmed);
        }
    }

    return folders;
}

/**
 * Prompt user to pick a working folder if multiple are configured.
 * Returns the selected folder or the only one available.
 * @returns {Promise<string|null>}
 */
async function pickWorkingFolder() {
    const folders = getAllWorkingFolders();
    if (folders.length === 0) return null;
    if (folders.length === 1) return folders[0];

    const picked = await vscode.window.showQuickPick(
        folders.map(f => ({
            label: path.basename(f),
            description: f,
            folder: f
        })),
        {
            placeHolder: 'Select SVN working folder',
            title: 'Multiple SVN Working Folders'
        }
    );

    return picked ? picked.folder : null;
}

/**
 * Get the working folder for a given file path (auto-detect which root it belongs to).
 * @param {string} filePath - Absolute path to a file
 * @returns {string|null}
 */
function getWorkingFolderForFile(filePath) {
    const folders = getAllWorkingFolders();
    const normalized = filePath.replace(/\\/g, '/').toLowerCase();

    for (const folder of folders) {
        const normalizedFolder = folder.replace(/\\/g, '/').toLowerCase();
        if (normalized.startsWith(normalizedFolder)) {
            return folder;
        }
    }

    return null;
}

// Keep old helpers for backward compatibility but update them:
function getWorkingFolder() {
    const folders = getAllWorkingFolders();
    return folders.length > 0 ? folders[0] : '';
}

function getWorkingFolderSafe() {
    const folders = getAllWorkingFolders();
    if (folders.length === 0) {
        vscode.window.showErrorMessage(
            'No SVN working folder configured. Please set svnRevisionGroup.workingFolders in settings.'
        );
        return null;
    }
    return folders[0];
}

/* ------------------------------ ACTIVATE -------------------------------- */

function activate(context) {
    const provider = new MyTreeDataProvider(context);
    provider.load();
    provider.migrateOldData();

    vscode.window.registerTreeDataProvider('svnRevisionManagerView', provider);

    /* -------------------- COMMAND: ADD GROUP -------------------- */
    context.subscriptions.push(
        vscode.commands.registerCommand("svnRevisionManager.addGroup", async (item) => {
            let root = null;

            // If called from a revisionsSection node or group node, use its rootFolder
            if (item && item.rootFolder) {
                root = item.rootFolder;
            }

            // If no root (e.g. called from command palette), prompt user
            if (!root) {
                root = await pickWorkingFolder();
            }
            if (!root) return;

            await provider.addGroup(root);
        })
    );

    /* ----------- COMMAND: DELETE GROUP ----------- */
    context.subscriptions.push(
        vscode.commands.registerCommand("svnRevisionManager.deleteGroup", async (item) => {
            if (!item || !item.groupName || !item.rootFolder) return;
            await provider.deleteGroup(item.rootFolder, item.groupName);
        })
    );

    /* ----------- COMMAND: RENAME GROUP ----------- */
    context.subscriptions.push(
        vscode.commands.registerCommand("svnRevisionManager.renameGroup", async (item) => {
            if (!item || !item.groupName || !item.rootFolder) return;
            await provider.renameGroup(item.rootFolder, item.groupName);
        })
    );

    /* ----------- COMMAND: ADD REVISION TO GROUP ----------- */
    context.subscriptions.push(
        vscode.commands.registerCommand("svnRevisionManager.addRevisionToGroup", async (item) => {
            if (!item || !item.groupName || !item.rootFolder) {
                vscode.window.showErrorMessage('Please right-click on a group to add a revision.');
                return;
            }
            await provider.addRevisionToGroup(item.rootFolder, item.groupName);
        })
    );

    /* ----------- COMMAND: DELETE REVISION ----------- */
    context.subscriptions.push(
        vscode.commands.registerCommand("svnRevisionManager.deleteRevision", async (item) => {
            if (!item || !item.revision || !item.groupName || !item.rootFolder) return;
            await provider.deleteRevision(item.rootFolder, item.groupName, item.revision);
        })
    );

    /* ----------- COMMAND: OPEN DIFF ----------- */
    context.subscriptions.push(
        vscode.commands.registerCommand("svnRevisionManager.openOnDoubleClick", async (item) => {
            if (!item || !item.filePath || !item.revision) return;

            const root = item.rootFolder || getWorkingFolderSafe();
            if (!root) return;

            const rev = String(item.revision);
            const prevRev = String(Number(rev) - 1);
            const filePath = item.filePath; // repo-relative path e.g. /trunk/src/file.php

            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Loading diff r${prevRev} ↔ r${rev}...`,
                cancellable: false
            }, async () => {
                try {
                    const [prevContent, currContent] = await Promise.all([
                        getSvnFileAtRevision(filePath, prevRev, root),
                        getSvnFileAtRevision(filePath, rev, root)
                    ]);

                    // Write to temp files
                    const tmpDir = path.join(os.tmpdir(), 'svn-revision-manager');
                    if (!fs.existsSync(tmpDir)) {
                        fs.mkdirSync(tmpDir, { recursive: true });
                    }

                    const fileName = path.basename(filePath);
                    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');

                    const prevFile = path.join(tmpDir, `r${prevRev}_${safeName}`);
                    const currFile = path.join(tmpDir, `r${rev}_${safeName}`);

                    fs.writeFileSync(prevFile, prevContent, 'utf-8');
                    fs.writeFileSync(currFile, currContent, 'utf-8');

                    await vscode.commands.executeCommand(
                        'vscode.diff',
                        vscode.Uri.file(prevFile),
                        vscode.Uri.file(currFile),
                        `${fileName}  r${prevRev} ↔ r${rev}`
                    );
                } catch (err) {
                    vscode.window.showErrorMessage(`Failed to open diff: ${err.message || err}`);
                }
            });
        })
    );

    /* ----------- COMMAND: COPY FILENAME ----------- */
    context.subscriptions.push(
        vscode.commands.registerCommand("svnRevisionManager.copyFileName", async (item) => {
            if (!item || !item.filePath) return;
            const name = path.basename(item.filePath);
            await vscode.env.clipboard.writeText(name);
            vscode.window.showInformationMessage(`Copied: ${name}`);
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
            if (!item || !item.groupName || !item.rootFolder) return;
            await provider.generateFileList(item.rootFolder, item.groupName);
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
        let rootFolder;

        if (node instanceof vscode.Uri) {
            rootFolder = getWorkingFolderForFile(node.fsPath);
            if (!rootFolder) {
                rootFolder = await pickWorkingFolder();
            }
            if (!rootFolder) return;
            filePath = path.relative(rootFolder, node.fsPath);
        } else if (node && (node.contextValue === 'file' || node.contextValue === 'lockedFile')) {
            filePath = node.filePath;
            rootFolder = node.rootFolder || getWorkingFolderSafe();
        } else {
            vscode.window.showErrorMessage('Please select a file.');
            return;
        }

        await lockFile(filePath, false, rootFolder);
    });

    // Register force lock file command
    let forceLockFileDisposable = vscode.commands.registerCommand('svnRevisionManager.forceLockFile', async (node) => {
        let filePath;
        let fileName;
        let rootFolder;

        if (node instanceof vscode.Uri) {
            rootFolder = getWorkingFolderForFile(node.fsPath);
            if (!rootFolder) {
                rootFolder = await pickWorkingFolder();
            }
            if (!rootFolder) return;
            filePath = path.relative(rootFolder, node.fsPath);
            fileName = path.basename(node.fsPath);
        } else if (node && (node.contextValue === 'file' || node.contextValue === 'lockedFile')) {
            filePath = node.filePath;
            fileName = node.label;
            rootFolder = node.rootFolder || getWorkingFolderSafe();
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
            await lockFile(filePath, true, rootFolder);
        }
    });

    // Register unlock file command
    let unlockFileDisposable = vscode.commands.registerCommand('svnRevisionManager.unlockFile', async (node) => {
        let filePath;
        let rootFolder;

        if (node instanceof vscode.Uri) {
            rootFolder = getWorkingFolderForFile(node.fsPath);
            if (!rootFolder) {
                rootFolder = await pickWorkingFolder();
            }
            if (!rootFolder) return;
            filePath = path.relative(rootFolder, node.fsPath);
        } else if (node && (node.contextValue === 'file' || node.contextValue === 'lockedFile')) {
            filePath = node.filePath;
            rootFolder = node.rootFolder || getWorkingFolderSafe();
        } else {
            vscode.window.showErrorMessage('Please select a file.');
            return;
        }

        await unlockFile(filePath, rootFolder);
    });

    context.subscriptions.push(lockFileDisposable);
    context.subscriptions.push(forceLockFileDisposable);
    context.subscriptions.push(unlockFileDisposable);

    /* ----------- COMMAND: REVERT FILE ----------- */
    context.subscriptions.push(
        vscode.commands.registerCommand('svnRevisionManager.revertFile', async (node) => {
            let filePath;
            let workingFolder;

            if (node instanceof vscode.Uri) {
                workingFolder = getWorkingFolderForFile(node.fsPath);
                if (!workingFolder) {
                    workingFolder = await pickWorkingFolder();
                }
                if (!workingFolder) return;
                filePath = path.relative(workingFolder, node.fsPath);
            } else if (node && (node.contextValue === 'file' || node.contextValue === 'lockedFile')) {
                filePath = node.filePath;
                workingFolder = node.rootFolder || getWorkingFolderSafe();
            } else {
                vscode.window.showErrorMessage('Please select a file.');
                return;
            }

            const svnPath = getSvnPath();
            if (!workingFolder || !svnPath) {
                vscode.window.showErrorMessage('SVN working folder or svn path not configured.');
                return;
            }

            const confirm = await vscode.window.showWarningMessage(
                `Revert all local changes to "${path.basename(filePath)}"? This cannot be undone.`,
                { modal: true },
                'Yes', 'No'
            );

            if (confirm !== 'Yes') return;

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
            let workingFolder;

            if (node instanceof vscode.Uri) {
                workingFolder = getWorkingFolderForFile(node.fsPath);
                if (!workingFolder) {
                    workingFolder = await pickWorkingFolder();
                }
                if (!workingFolder) return;
                filePath = path.relative(workingFolder, node.fsPath);
            } else if (node && (node.contextValue === 'file' || node.contextValue === 'lockedFile')) {
                filePath = node.filePath;
                workingFolder = node.rootFolder || getWorkingFolderSafe();
            } else {
                vscode.window.showErrorMessage('Please select a file.');
                return;
            }

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
            let workingFolder;

            if (node instanceof vscode.Uri) {
                workingFolder = getWorkingFolderForFile(node.fsPath);
                if (!workingFolder) {
                    workingFolder = await pickWorkingFolder();
                }
                if (!workingFolder) return;
                filePath = path.relative(workingFolder, node.fsPath);
            } else if (node && (node.contextValue === 'file' || node.contextValue === 'lockedFile')) {
                filePath = node.filePath;
                workingFolder = node.rootFolder || getWorkingFolderSafe();
            } else {
                vscode.window.showErrorMessage('Please select a file.');
                return;
            }

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

            const svnPath = getSvnPath();
            if (!svnPath) {
                lockStatusBar.hide();
                return;
            }

            const fsPath = editor.document.uri.fsPath;
            const workingFolder = getWorkingFolderForFile(fsPath);
            if (!workingFolder) {
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

            const root = node.rootFolder || getWorkingFolderSafe();
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
        isNewFile = false,
        isModifiedFile = false,
        isModifiedLocked = false,
        rootFolder = null,
        rootLabel = null,
        description = null,
        tooltip = null,

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
        
        this.isNewFile = isNewFile;
        this.isModifiedFile = isModifiedFile;
        this.isModifiedLocked = isModifiedLocked;
        this.rootFolder = rootFolder;
        this.rootLabel = rootLabel;
        
        if (description) this.description = description;
        if (tooltip) this.tooltip = tooltip;

        if (isSection) {
            if (sectionKey === "revisions") {
                this.contextValue = "revisionsSection";
            } else if (sectionKey === "locks") {
                this.contextValue = "locksSection";
            } else {
                this.contextValue = "section";
            }
            this.iconPath = new vscode.ThemeIcon(sectionKey === "locks" ? "lock" : "folder-library");
            this.command = null;
            return;
        }

        if (isLocksGroup) {
            this.contextValue = "locksGroup";
            let icon = "lock";
            if (locksGroupKey === "newFiles") icon = "new-file";
            else if (locksGroupKey === "modifiedLocked") icon = "edit";
            else if (locksGroupKey === "modifiedNotLocked") icon = "warning";
            this.iconPath = new vscode.ThemeIcon(icon);
            this.command = null;
            return;
        }

        if (isNewFile) {
            this.contextValue = "file";
            this.iconPath = new vscode.ThemeIcon("new-file");
            const showRoot = getAllWorkingFolders().length > 1;
            this.description = showRoot && this.rootLabel ? `new · ${this.rootLabel}` : "new";
            this.tooltip = `New file (not in SVN)\nPath: ${label}${this.rootLabel ? '\nRepo: ' + this.rootLabel : ''}`;

            try {
                const wf = this.rootFolder || getWorkingFolderSafe();
                if (wf && filePath) {
                    const abs = path.join(wf, filePath);
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

        if (isLockedFile) {
            this.contextValue = "lockedFile";
            this.iconPath = new vscode.ThemeIcon("lock");

            if (lockOwner) {
                const createdShort = lockCreated ? lockCreated.replace(/\s*\(.*\)\s*$/, '').trim() : '';
                this.description = createdShort ? `${lockOwner} @ ${createdShort}` : lockOwner;

                this.tooltip = [
                    `SVN Locked File`,
                    `Path: ${label}`,
                    `Owner: ${lockOwner}`,
                    lockCreated ? `Created: ${lockCreated}` : null
                ].filter(Boolean).join("\n");
            } else {
                this.description = '';
                this.tooltip = `SVN Locked File\nPath: ${label}\n\nClick "Show Lock Info" to see details`;
            }

            try {
                const wf = this.rootFolder || getWorkingFolderSafe();
                if (wf && filePath) {
                    const abs = path.join(wf, filePath);
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
            this.iconPath = new vscode.ThemeIcon("folder");
            return;
        }

        // Revision node (has revision but no isFile)
        if (revision && !isFile) {
            this.contextValue = "revision";
            this.iconPath = new vscode.ThemeIcon("git-commit");
            return;
        }

        // File node inside a revision
        if (isFile && filePath) {
            this.contextValue = "file";
            this.iconPath = new vscode.ThemeIcon("file");
            this.command = {
                command: "svnRevisionManager.openOnDoubleClick",
                title: "Open Diff",
                arguments: [this]
            };
            return;
        }
        
        if (isModifiedFile) {
            this.contextValue = isModifiedLocked ? "lockedFile" : "file";
            this.iconPath = new vscode.ThemeIcon(isModifiedLocked ? "lock" : "edit");
            const showRoot = getAllWorkingFolders().length > 1;
            const modLabel = isModifiedLocked ? "modified + locked" : "modified";
            this.description = showRoot && this.rootLabel ? `${modLabel} · ${this.rootLabel}` : modLabel;

            try {
                const wf = this.rootFolder || getWorkingFolderSafe();
                if (wf && filePath) {
                    const abs = path.join(wf, filePath);
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
    }
}

/* ------------------------------ SVN HELPERS -------------------------------- */

function getCommitMessage(revision, root) {
    const svnPath = getSvnPath();
    const cwd = root || getWorkingFolderSafe();
    if (!cwd) return Promise.resolve('');

    return new Promise((resolve) => {
        exec(`"${svnPath}" log -r ${revision} --quiet`, { cwd }, (error, stdout) => {
            if (error) return resolve('');
            resolve(stdout || '');
        });
    });
}

function getChangedFiles(revision, root) {
    const svnPath = getSvnPath();
    const cwd = root || getWorkingFolderSafe();
    if (!cwd) return Promise.resolve([]);

    return new Promise((resolve) => {
        exec(`"${svnPath}" log -r ${revision} -v --quiet`, { cwd }, (error, stdout) => {
            if (error) return resolve([]);

            const lines = (stdout || '').split(/\r?\n/);
            const files = [];
            let inChanged = false;

            for (const line of lines) {
                if (line.startsWith('Changed paths:') || line.startsWith('   ')) {
                    inChanged = true;
                }
                if (inChanged && /^\s+[AMDR]\s+/.test(line)) {
                    const match = line.match(/^\s+[AMDR]\s+(.+?)(\s+\(from\s+.*\))?$/);
                    if (match && match[1]) {
                        files.push(match[1].trim());
                    }
                }
            }

            resolve(files);
        });
    });
}

/**
 * Get commit info (message, date, file count) from SVN for a revision.
 * @param {string} revision
 * @param {string} root
 * @returns {Promise<{message: string, date: string, fileCount: number}>}
 */
function getCommitInfoFromSvn(revision, root) {
    const svnPath = getSvnPath();
    const cwd = root || getWorkingFolderSafe();
    if (!cwd) return Promise.resolve({ message: '', date: '', fileCount: 0 });

    return new Promise((resolve) => {
        exec(`"${svnPath}" log -r ${revision} -v`, { cwd, maxBuffer: 1024 * 1024 }, (error, stdout) => {
            if (error) return resolve({ message: '', date: '', fileCount: 0 });

            const lines = (stdout || '').split(/\r?\n/);
            let message = '';
            let date = '';
            let fileCount = 0;

            // Parse header line: r12345 | author | 2026-04-15 10:00:00 +0800 (...) | 1 line
            for (const line of lines) {
                if (/^r\d+\s*\|/.test(line.trim())) {
                    const parts = line.split('|');
                    if (parts.length >= 3) {
                        const rawDate = parts[2].trim();
                        // Extract just YYYY-MM-DD HH:MM
                        const dateMatch = rawDate.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/);
                        if (dateMatch) {
                            date = `${dateMatch[1]} ${dateMatch[2]}`;
                        }
                    }
                    break;
                }
            }

            // Count changed files (lines starting with spaces + A/M/D/R)
            for (const line of lines) {
                if (/^\s+[AMDR]\s+/.test(line)) {
                    fileCount++;
                }
            }

            // Parse commit message (after blank line following header)
            let foundHeader = false;
            let pastBlank = false;
            const messageLines = [];

            for (const line of lines) {
                if (/^-{4,}$/.test(line.trim())) {
                    if (foundHeader && messageLines.length > 0) break;
                    foundHeader = true;
                    pastBlank = false;
                    continue;
                }
                if (foundHeader && !pastBlank) {
                    if (/^r\d+\s*\|/.test(line.trim())) continue;
                    if (line.trim() === '') { pastBlank = true; continue; }
                }
                if (foundHeader && pastBlank) {
                    messageLines.push(line);
                }
            }

            while (messageLines.length > 0 && messageLines[messageLines.length - 1].trim() === '') {
                messageLines.pop();
            }

            message = messageLines.join('\n').trim();

            resolve({ message, date, fileCount });
        });
    });
}

/**
 * Get the repository root URL for a working copy.
 */
function getRepoRootUrl(root) {
    const svnPath = getSvnPath();
    if (!svnPath || !root) return Promise.resolve(null);

    return new Promise((resolve) => {
        exec(`"${svnPath}" info "${root}"`, { cwd: root }, (error, stdout) => {
            if (error) return resolve(null);
            const m = (stdout || '').match(/^\s*Repository Root:\s*(.+)\s*$/mi);
            resolve(m ? m[1].trim() : null);
        });
    });
}

/**
 * Get file content at a specific revision from SVN.
 */
async function getSvnFileAtRevision(repoRelPath, revision, root) {
    const svnPath = getSvnPath();
    if (!svnPath || !root) return '';

    const repoRoot = await getRepoRootUrl(root);
    if (!repoRoot) return '';

    const cleanPath = repoRelPath.startsWith('/') ? repoRelPath : '/' + repoRelPath;
    const fileUrl = repoRoot + cleanPath;

    return new Promise((resolve) => {
        exec(`"${svnPath}" cat "${fileUrl}" -r ${revision}`, { cwd: root, maxBuffer: 1024 * 1024 * 10 }, (error, stdout) => {
            if (error) return resolve('');
            resolve(stdout || '');
        });
    });
}

// function runSvnDiff(revision, filePath, root) {
//     const svnPath = getSvnPath();
//     const cwd = root || getWorkingFolderSafe();
//     if (!cwd) return Promise.resolve('');

//     let cmd = `"${svnPath}" diff -c ${revision}`;
//     if (filePath) {
//         cmd += ` "${filePath}"`;
//     }

//     return new Promise((resolve) => {
//         exec(cmd, { cwd, maxBuffer: 1024 * 1024 * 10 }, (error, stdout) => {
//             if (error) return resolve('');
//             resolve(stdout || '');
//         });
//     });
// }

/* ------------------------------ LOCKS -------------------------------- */

function parseSvnStatusShowUpdates(stdout) {
    const lines = (stdout || '').split(/\r?\n/).filter(l => l.trim().length > 0);

    const mineCandidates = new Set();
    const othersCandidates = new Set();
    const newFiles = new Set();
    const modifiedLocked = new Set();
    const modifiedNotLocked = new Set();

    for (const line of lines) {
        if (/^Status against revision:/i.test(line.trim())) continue;
        if (line.length < 7) continue;

        const flags = line.slice(0, 7);
        const itemCode = flags[0];
        const lockFlag = flags[5];

        const trimmed = line.trim();
        const parts = trimmed.split(/\s+/);
        const rel = parts[parts.length - 1];

        if (!rel || rel === '.' || rel === '..') continue;

        // Detect new files: '?' = unversioned, 'A' = added but not committed
        if (itemCode === '?' || itemCode === 'A') {
            newFiles.add(rel);
        }

        // Detect modified files: 'M' = modified
        if (itemCode === 'M') {
            if (lockFlag === 'K') {
                modifiedLocked.add(rel);
            } else {
                modifiedNotLocked.add(rel);
            }
        }

        if (lockFlag === 'K') {
            mineCandidates.add(rel);
        } else if (lockFlag === 'O' || lockFlag === 'T') {
            othersCandidates.add(rel);
        }
    }

    return {
        mineCandidates: Array.from(mineCandidates),
        othersCandidates: Array.from(othersCandidates),
        newFiles: Array.from(newFiles),
        modifiedLocked: Array.from(modifiedLocked),
        modifiedNotLocked: Array.from(modifiedNotLocked)
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

// ...existing code...

async function getWorkingCopyLocks() {
    const svnPath = getSvnPath();
    const folders = getAllWorkingFolders();

    if (!svnPath || folders.length === 0) {
        return { locks: [], newFiles: [], modifiedLocked: [], modifiedNotLocked: [] };
    }

    const allLocks = [];
    const allNewFiles = [];
    const allModifiedLocked = [];
    const allModifiedNotLocked = [];

    for (const root of folders) {
        if (!fs.existsSync(root)) continue;

        let statusOut = '';
        try {
            const { stdout } = await execAsync(
                `"${svnPath}" status --show-updates --ignore-externals`,
                { cwd: root }
            );
            statusOut = stdout || '';
        } catch {
            try {
                const { stdout } = await execAsync(
                    `"${svnPath}" status -u --ignore-externals`,
                    { cwd: root }
                );
                statusOut = stdout || '';
            } catch {
                continue;
            }
        }

        const { mineCandidates, othersCandidates, newFiles, modifiedLocked, modifiedNotLocked } =
            parseSvnStatusShowUpdates(statusOut);

        const folderLabel = path.basename(root);

        // For "mine" locks - fetch details
        for (const rel of mineCandidates) {
            const abs = path.join(root, rel);
            const fileUrl = await getUrlForLocalPath(abs, root);
            if (!fileUrl) continue;

            const remoteLock = await getRemoteLockInfoByUrl(fileUrl, root);
            if (!remoteLock) continue;

            allLocks.push({
                relPath: rel.replace(/\\/g, '/'),
                owner: remoteLock.owner,
                created: remoteLock.created,
                category: 'mine',
                root: root,
                rootLabel: folderLabel
            });
        }

        // For "others" locks - do NOT fetch details
        for (const rel of othersCandidates) {
            allLocks.push({
                relPath: rel.replace(/\\/g, '/'),
                owner: null,
                created: null,
                category: 'others',
                root: root,
                rootLabel: folderLabel
            });
        }

        for (const f of newFiles) {
            allNewFiles.push({ relPath: f.replace(/\\/g, '/'), root, rootLabel: folderLabel });
        }
        for (const f of modifiedLocked) {
            allModifiedLocked.push({ relPath: f.replace(/\\/g, '/'), root, rootLabel: folderLabel });
        }
        for (const f of modifiedNotLocked) {
            allModifiedNotLocked.push({ relPath: f.replace(/\\/g, '/'), root, rootLabel: folderLabel });
        }
    }

    // Deduplicate locks
    const uniq = new Map();
    for (const l of allLocks) {
        const key = `${l.root}|${l.relPath}`;
        if (!uniq.has(key)) uniq.set(key, l);
    }

    const sortedLocks = Array.from(uniq.values()).sort((a, b) =>
        (a.category || '').localeCompare(b.category || '') ||
        a.relPath.localeCompare(b.relPath)
    );

    return {
        locks: sortedLocks,
        newFiles: allNewFiles.sort((a, b) => a.relPath.localeCompare(b.relPath)),
        modifiedLocked: allModifiedLocked.sort((a, b) => a.relPath.localeCompare(b.relPath)),
        modifiedNotLocked: allModifiedNotLocked.sort((a, b) => a.relPath.localeCompare(b.relPath))
    };
}

// ...existing code...

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
        this.groups = {};     // keyed by rootFolder: { rootFolder: { groupName: [revisions] } }
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;

        this._locksCache = {};    // keyed by rootFolder
        this._locksCacheAt = {};  // keyed by rootFolder
    }

    refresh() {
        this._onDidChangeTreeData.fire();
    }

    clearLocksCache() {
        this._locksCache = {};
        this._locksCacheAt = {};
    }

    clearLocksCacheForRoot(root) {
        delete this._locksCache[root];
        delete this._locksCacheAt[root];
    }

    /* ---- DATA PATH PER ROOT ---- */
    _getDataPathForRoot(root) {
        const config = vscode.workspace.getConfiguration('svnRevisionGroup');
        const customBase = config.get('dataPath') || '';
        const folderName = path.basename(root).replace(/[^a-zA-Z0-9_-]/g, '_');

        if (customBase && fs.existsSync(customBase)) {
            return path.join(customBase, `revisions_${folderName}.json`);
        }

        return path.join(this.context.globalStorageUri.fsPath, `revisions_${folderName}.json`);
    }

    /* ---- LOAD / SAVE PER ROOT ---- */
    load() {
        this.groups = {};
        const folders = getAllWorkingFolders();
        for (const root of folders) {
            const filePath = this._getDataPathForRoot(root);
            if (fs.existsSync(filePath)) {
                try {
                    const raw = fs.readFileSync(filePath, 'utf-8');
                    this.groups[root] = JSON.parse(raw);
                } catch {
                    this.groups[root] = {};
                }
            } else {
                this.groups[root] = {};
            }
        }
    }

    _saveRoot(root) {
        const filePath = this._getDataPathForRoot(root);
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(filePath, JSON.stringify(this.groups[root] || {}, null, 2));
    }

    save() {
        const folders = getAllWorkingFolders();
        for (const root of folders) {
            this._saveRoot(root);
        }
    }

    /* ---- MIGRATE OLD DATA (one-time) ---- */
    migrateOldData() {
        const config = vscode.workspace.getConfiguration('svnRevisionGroup');
        const customBase = config.get('dataPath') || '';

        let oldPath;
        if (customBase && fs.existsSync(customBase)) {
            oldPath = path.join(customBase, 'revisions.json');
        } else {
            oldPath = path.join(this.context.globalStorageUri.fsPath, 'revisions.json');
        }

        if (fs.existsSync(oldPath)) {
            try {
                const raw = fs.readFileSync(oldPath, 'utf-8');
                const oldGroups = JSON.parse(raw);

                if (oldGroups && typeof oldGroups === 'object' && Object.keys(oldGroups).length > 0) {
                    // Assign old data to the first working folder
                    const folders = getAllWorkingFolders();
                    if (folders.length > 0) {
                        const firstRoot = folders[0];
                        if (!this.groups[firstRoot] || Object.keys(this.groups[firstRoot]).length === 0) {
                            this.groups[firstRoot] = oldGroups;
                            this._saveRoot(firstRoot);
                        }
                    }

                    // Rename old file to avoid re-migration
                    const backupPath = oldPath + '.migrated';
                    fs.renameSync(oldPath, backupPath);
                    vscode.window.showInformationMessage(
                        `SVN Revision Manager: Migrated old revision data to "${folders[0]}". Old file backed up.`
                    );
                }
            } catch {
                // ignore migration errors
            }
        }
    }

    /* ---- GROUP OPERATIONS ---- */
    async addGroup(root) {
        if (!root) {
            root = await pickWorkingFolder();
        }
        if (!root) return;

        const name = await vscode.window.showInputBox({ prompt: "Enter group name" });
        if (!name) return;

        if (!this.groups[root]) this.groups[root] = {};

        if (this.groups[root][name]) {
            vscode.window.showWarningMessage(`Group "${name}" already exists in ${path.basename(root)}.`);
            return;
        }

        this.groups[root][name] = [];
        this._saveRoot(root);
        this.refresh();
    }

    async deleteGroup(root, groupName) {
        if (!root || !groupName) return;

        const confirm = await vscode.window.showWarningMessage(
            `Delete group "${groupName}" from ${path.basename(root)}?`,
            { modal: true },
            'Yes', 'No'
        );
        if (confirm !== 'Yes') return;

        if (this.groups[root]) {
            delete this.groups[root][groupName];
            this._saveRoot(root);
            this.refresh();
        }
    }

    async renameGroup(root, oldName) {
        if (!root || !oldName) return;

        const newName = await vscode.window.showInputBox({
            prompt: "Enter new group name",
            value: oldName
        });
        if (!newName || newName === oldName) return;

        if (!this.groups[root]) return;

        if (this.groups[root][newName]) {
            vscode.window.showWarningMessage(`Group "${newName}" already exists.`);
            return;
        }

        this.groups[root][newName] = this.groups[root][oldName];
        delete this.groups[root][oldName];
        this._saveRoot(root);
        this.refresh();
    }

    async addRevisionToGroup(root, groupName) {
        if (!root || !groupName) return;

        const rev = await vscode.window.showInputBox({
            prompt: `Enter revision number to add to "${groupName}"`
        });
        if (!rev) return;

        if (!this.groups[root]) this.groups[root] = {};
        if (!this.groups[root][groupName]) this.groups[root][groupName] = [];

        const exists = this.groups[root][groupName].some(r => {
            const rNum = typeof r === 'object' ? r.revision : r;
            return rNum === rev;
        });

        if (exists) {
            vscode.window.showWarningMessage(`Revision ${rev} already exists in group "${groupName}".`);
            return;
        }

        let message = '';
        let date = '';
        let fileCount = 0;

        try {
            const info = await getCommitInfoFromSvn(rev, root);
            message = info.message || '';
            date = info.date || '';
            fileCount = info.fileCount || 0;
        } catch {
            // If fetch fails, leave empty
        }

        this.groups[root][groupName].push({ revision: rev, message, date, fileCount });
        this._saveRoot(root);
        this.refresh();
    }

    async deleteRevision(root, groupName, revision) {
        if (!root || !groupName || !revision) return;

        if (this.groups[root] && this.groups[root][groupName]) {
            this.groups[root][groupName] = this.groups[root][groupName].filter(r => {
                const rNum = typeof r === 'object' ? r.revision : r;
                return rNum !== revision;
            });
            this._saveRoot(root);
            this.refresh();
        }
    }

    async generateFileList(root, groupName) {
        if (!root || !groupName) return;

        const revisions = (this.groups[root] && this.groups[root][groupName]) || [];
        if (revisions.length === 0) {
            vscode.window.showWarningMessage(`No revisions in group "${groupName}".`);
            return;
        }

        const allFiles = new Set();

        for (const entry of revisions) {
            const rev = typeof entry === 'object' ? entry.revision : entry;
            const files = await getChangedFiles(rev, root);
            for (const f of files) {
                allFiles.add(f);
            }
        }

        const sorted = Array.from(allFiles).sort();
        const doc = await vscode.workspace.openTextDocument({
            content: sorted.join('\n'),
            language: 'plaintext'
        });
        vscode.window.showTextDocument(doc);
    }

    /* ---- LOCKS CACHE PER ROOT ---- */
    async _getLocksCachedForRoot(root) {
        const now = Date.now();
        if (this._locksCache[root] && (now - (this._locksCacheAt[root] || 0)) < 30_000) {
            return this._locksCache[root];
        }

        const result = await getWorkingCopyLocksForRoot(root);
        this._locksCache[root] = result;
        this._locksCacheAt[root] = now;
        return result;
    }

    /* ---- TREE ---- */
    getTreeItem(element) {
        return element;
    }

    async getChildren(element) {
        /* ---------- ROOT LEVEL ---------- */
        if (!element) {
            const folders = getAllWorkingFolders();
            if (folders.length === 0) {
                return [
                    new MyTreeItem({
                        label: "No SVN working folders configured",
                        collapsibleState: vscode.TreeItemCollapsibleState.None
                    })
                ];
            }

            const items = [];
            for (const root of folders) {
                const rootLabel = path.basename(root);
                // Revisions section per root
                items.push(new MyTreeItem({
                    label: `📁 ${rootLabel} - Revisions`,
                    collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
                    isSection: true,
                    sectionKey: "revisions",
                    rootFolder: root,
                    rootLabel: rootLabel
                }));
                // Locks section per root
                items.push(new MyTreeItem({
                    label: `🔒 ${rootLabel} - Locks`,
                    collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
                    isSection: true,
                    sectionKey: "locks",
                    rootFolder: root,
                    rootLabel: rootLabel
                }));
            }
            return items;
        }

        /* ---------- SECTION: REVISIONS (per root) ---------- */
        if (element.isSection && element.sectionKey === "revisions") {
            const root = element.rootFolder;
            const groups = (this.groups[root]) || {};

            return Object.keys(groups).map(groupName =>
                new MyTreeItem({
                    label: groupName,
                    collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
                    isGroup: true,
                    groupName,
                    rootFolder: root,
                    rootLabel: element.rootLabel
                })
            );
        }

        /* ---------- SECTION: LOCKS (per root) ---------- */
        if (element.isSection && element.sectionKey === "locks") {
            const root = element.rootFolder;
            const result = await this._getLocksCachedForRoot(root);
            const locks = result.locks || [];
            const newFiles = result.newFiles || [];
            const modifiedLocked = result.modifiedLocked || [];
            const modifiedNotLocked = result.modifiedNotLocked || [];

            const mine = locks.filter(l => l.category === 'mine');
            const others = locks.filter(l => l.category === 'others');

            return [
                new MyTreeItem({
                    label: `New Files (${newFiles.length})`,
                    collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
                    isLocksGroup: true,
                    locksGroupKey: "newFiles",
                    rootFolder: root,
                    rootLabel: element.rootLabel
                }),
                new MyTreeItem({
                    label: `Locked by me (${mine.length})`,
                    collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
                    isLocksGroup: true,
                    locksGroupKey: "mine",
                    rootFolder: root,
                    rootLabel: element.rootLabel
                }),
                new MyTreeItem({
                    label: `Locked by others (${others.length})`,
                    collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
                    isLocksGroup: true,
                    locksGroupKey: "others",
                    rootFolder: root,
                    rootLabel: element.rootLabel
                }),
                new MyTreeItem({
                    label: `Modified (Locked) (${modifiedLocked.length})`,
                    collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
                    isLocksGroup: true,
                    locksGroupKey: "modifiedLocked",
                    rootFolder: root,
                    rootLabel: element.rootLabel
                }),
                new MyTreeItem({
                    label: `Modified (Not Locked) (${modifiedNotLocked.length})`,
                    collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
                    isLocksGroup: true,
                    locksGroupKey: "modifiedNotLocked",
                    rootFolder: root,
                    rootLabel: element.rootLabel
                })
            ];
        }

        /* ---------- LOCKS GROUP: NEW FILES ---------- */
        if (element.isLocksGroup && element.locksGroupKey === "newFiles") {
            const root = element.rootFolder;
            const result = await this._getLocksCachedForRoot(root);
            const newFiles = result.newFiles || [];

            return newFiles.map(f => {
                const item = new MyTreeItem({
                    label: f.relPath,
                    collapsibleState: vscode.TreeItemCollapsibleState.None,
                    isNewFile: true,
                    filePath: f.relPath,
                    rootFolder: root,
                    rootLabel: element.rootLabel
                });
                return item;
            });
        }

        /* ---------- LOCKS GROUP: MINE ---------- */
        if (element.isLocksGroup && element.locksGroupKey === "mine") {
            const root = element.rootFolder;
            const result = await this._getLocksCachedForRoot(root);
            const locks = result.locks || [];
            const mine = locks.filter(l => l.category === 'mine');

            return mine.map(l => new MyTreeItem({
                label: l.relPath,
                collapsibleState: vscode.TreeItemCollapsibleState.None,
                isLockedFile: true,
                filePath: l.relPath,
                lockOwner: l.owner,
                lockCreated: l.created,
                rootFolder: root,
                rootLabel: element.rootLabel
            }));
        }

        /* ---------- LOCKS GROUP: OTHERS ---------- */
        if (element.isLocksGroup && element.locksGroupKey === "others") {
            const root = element.rootFolder;
            const result = await this._getLocksCachedForRoot(root);
            const locks = result.locks || [];
            const others = locks.filter(l => l.category === 'others');

            return others.map(l => new MyTreeItem({
                label: l.relPath,
                collapsibleState: vscode.TreeItemCollapsibleState.None,
                isLockedFile: true,
                filePath: l.relPath,
                lockOwner: l.owner,
                lockCreated: l.created,
                rootFolder: root,
                rootLabel: element.rootLabel
            }));
        }

        /* ---------- LOCKS GROUP: MODIFIED (LOCKED) ---------- */
        if (element.isLocksGroup && element.locksGroupKey === "modifiedLocked") {
            const root = element.rootFolder;
            const result = await this._getLocksCachedForRoot(root);
            const modifiedLocked = result.modifiedLocked || [];

            return modifiedLocked.map(f => {
                const item = new MyTreeItem({
                    label: f.relPath,
                    collapsibleState: vscode.TreeItemCollapsibleState.None,
                    isModifiedFile: true,
                    isModifiedLocked: true,
                    filePath: f.relPath,
                    rootFolder: root,
                    rootLabel: element.rootLabel
                });
                return item;
            });
        }

        /* ---------- LOCKS GROUP: MODIFIED (NOT LOCKED) ---------- */
        if (element.isLocksGroup && element.locksGroupKey === "modifiedNotLocked") {
            const root = element.rootFolder;
            const result = await this._getLocksCachedForRoot(root);
            const modifiedNotLocked = result.modifiedNotLocked || [];

            return modifiedNotLocked.map(f => {
                const item = new MyTreeItem({
                    label: f.relPath,
                    collapsibleState: vscode.TreeItemCollapsibleState.None,
                    isModifiedFile: true,
                    isModifiedLocked: false,
                    filePath: f.relPath,
                    rootFolder: root,
                    rootLabel: element.rootLabel
                });
                return item;
            });
        }

        /* ---------- GROUP LEVEL (revisions in a group) ---------- */
        if (element.isGroup && element.groupName) {
            const root = element.rootFolder;
            const revisions = (this.groups[root] && this.groups[root][element.groupName]) || [];

            // Enrich any entries missing date or fileCount
            let needsSave = false;
            for (let i = 0; i < revisions.length; i++) {
                const entry = revisions[i];
                if (typeof entry === 'object') {
                    const missingDate = !entry.date;
                    const missingFileCount = entry.fileCount === undefined || entry.fileCount === null;

                    if (missingDate || missingFileCount) {
                        try {
                            const info = await getCommitInfoFromSvn(entry.revision, root);
                            if (missingDate && info.date) entry.date = info.date;
                            if (missingFileCount && info.fileCount) entry.fileCount = info.fileCount;
                            if (!entry.message && info.message) entry.message = info.message;
                            needsSave = true;
                        } catch {
                            // ignore, show what we have
                        }
                    }
                }
            }

            if (needsSave) {
                this._saveRoot(root);
            }

            return [...revisions]
                .sort((a, b) => {
                    const revA = Number(typeof a === 'object' ? a.revision : a);
                    const revB = Number(typeof b === 'object' ? b.revision : b);
                    return revA - revB;
                })
                .map(entry => {
                    const rev = typeof entry === 'object' ? entry.revision : entry;
                    const msg = typeof entry === 'object' ? (entry.message || '') : '';
                    const date = typeof entry === 'object' ? (entry.date || '') : '';
                    const fileCount = typeof entry === 'object' ? (entry.fileCount || 0) : 0;

                    const parts = [];
                    if (date) parts.push(date);
                    //if (fileCount > 0) parts.push(`${fileCount} file${fileCount !== 1 ? 's' : ''}`);
                    if (msg) parts.push(msg);
                    const description = parts.join('  ·  ');

                    return new MyTreeItem({
                        label: `r${rev}`,
                        collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
                        revision: rev,
                        groupName: element.groupName,
                        rootFolder: root,
                        rootLabel: element.rootLabel,
                        description: description || undefined,
                        tooltip: [
                            `Revision: r${rev}`,
                            date ? `Date: ${date}` : null,
                            fileCount ? `Files changed: ${fileCount}` : null,
                            msg ? `Message: ${msg}` : null
                        ].filter(Boolean).join('\n')
                    });
                });
        }

        /* ---------- REVISION LEVEL (files in a revision) ---------- */
        if (element.revision) {
            const root = element.rootFolder;
            const files = await getChangedFiles(element.revision, root);

            return files.map(f =>
                new MyTreeItem({
                    label: f,
                    collapsibleState: vscode.TreeItemCollapsibleState.None,
                    isFile: true,
                    filePath: f,
                    revision: element.revision,
                    groupName: element.groupName,
                    rootFolder: root,
                    rootLabel: element.rootLabel
                })
            );
        }

        return [];
    }
}

/* ------------------------------ HELPERS -------------------------------- */

async function getWorkingCopyLocksForRoot(root) {
    const svnPath = getSvnPath();

    if (!svnPath || !root || !fs.existsSync(root)) {
        return { locks: [], newFiles: [], modifiedLocked: [], modifiedNotLocked: [] };
    }

    let statusOut = '';
    try {
        const { stdout } = await execAsync(
            `"${svnPath}" status --show-updates --ignore-externals`,
            { cwd: root }
        );
        statusOut = stdout || '';
    } catch {
        try {
            const { stdout } = await execAsync(
                `"${svnPath}" status -u --ignore-externals`,
                { cwd: root }
            );
            statusOut = stdout || '';
        } catch {
            return { locks: [], newFiles: [], modifiedLocked: [], modifiedNotLocked: [] };
        }
    }

    const { mineCandidates, othersCandidates, newFiles, modifiedLocked, modifiedNotLocked } =
        parseSvnStatusShowUpdates(statusOut);

    const folderLabel = path.basename(root);
    const locks = [];

    // For "mine" locks - fetch details
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
            category: 'mine',
            root: root,
            rootLabel: folderLabel
        });
    }

    // For "others" locks - do NOT fetch details
    for (const rel of othersCandidates) {
        locks.push({
            relPath: rel.replace(/\\/g, '/'),
            owner: null,
            created: null,
            category: 'others',
            root: root,
            rootLabel: folderLabel
        });
    }

    // Deduplicate locks
    const uniq = new Map();
    for (const l of locks) {
        if (!uniq.has(l.relPath)) uniq.set(l.relPath, l);
    }

    const sortedLocks = Array.from(uniq.values()).sort((a, b) =>
        (a.category || '').localeCompare(b.category || '') ||
        a.relPath.localeCompare(b.relPath)
    );

    return {
        locks: sortedLocks,
        newFiles: newFiles.map(f => ({ relPath: f.replace(/\\/g, '/'), root, rootLabel: folderLabel })).sort((a, b) => a.relPath.localeCompare(b.relPath)),
        modifiedLocked: modifiedLocked.map(f => ({ relPath: f.replace(/\\/g, '/'), root, rootLabel: folderLabel })).sort((a, b) => a.relPath.localeCompare(b.relPath)),
        modifiedNotLocked: modifiedNotLocked.map(f => ({ relPath: f.replace(/\\/g, '/'), root, rootLabel: folderLabel })).sort((a, b) => a.relPath.localeCompare(b.relPath))
    };
}

function ensureStorageFolderExists(folder) {
    if (!fs.existsSync(folder)) {
        fs.mkdirSync(folder, { recursive: true });
    }
}

// function getWorkingFolder() {
//     const config = vscode.workspace.getConfiguration("svnRevisionGroup");
//     const folder = config.get("workingFolder");

//     if (!folder || folder.trim() === "") {
//         vscode.window.showErrorMessage(
//             "SVN working folder is not set. Please configure it in Settings."
//         );
//         throw new Error("SVN working folder not set");
//     }

//     return folder;
// }

// function getWorkingFolderSafe() {
//     try {
//         const config = vscode.workspace.getConfiguration("svnRevisionGroup");
//         const folder = config.get("workingFolder");
//         if (!folder || folder.trim() === "") {
//             return null;
//         }
//         return folder;
//     } catch {
//         return null;
//     }
// }

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
async function lockFile(filePath, force = false, rootFolder = null) {
    const svnPath = getSvnPath();
    const workingFolder = rootFolder || getWorkingFolderSafe();

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
async function unlockFile(filePath, rootFolder = null) {
    const svnPath = getSvnPath();
    const workingFolder = rootFolder || getWorkingFolderSafe();

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
            const folders = getAllWorkingFolders();
            if (folders.length === 0) {
                this._statusCache.clear();
                this._emitter.fire(undefined);
                return;
            }

            const newCache = new Map();

            for (const root of folders) {
                if (!fs.existsSync(root)) continue;
                const statuses = await this._collectStatuses(root);
                for (const [key, value] of statuses) {
                    newCache.set(key, value);
                }
            }

            this._statusCache = newCache;
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


function deactivate() {
    // Clean up temp diff files on extension deactivation
    try {
        const tmpDir = path.join(os.tmpdir(), 'svn-revision-manager');
        if (fs.existsSync(tmpDir)) {
            for (const file of fs.readdirSync(tmpDir)) {
                try { fs.unlinkSync(path.join(tmpDir, file)); } catch { /* ignore */ }
            }
        }
    } catch { /* ignore */ }
}

module.exports = { activate, deactivate };