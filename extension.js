const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const SVN_WORKING_FOLDER = "";

/* ------------------------------ ACTIVATE -------------------------------- */

function activate(context) {
    const storageFile = path.join(context.globalStorageUri.fsPath, "revisions.json");

    ensureStorageFolderExists(context.globalStorageUri.fsPath);

    const provider = new MyTreeDataProvider(storageFile);
    provider.load();   // <-- load groups + revisions

    vscode.window.createTreeView("svnRevisionManagerView", {
        treeDataProvider: provider
    });

    /* -------------------- COMMAND: ADD GROUP -------------------- */
    context.subscriptions.push(
        vscode.commands.registerCommand("svnRevisionManager.addGroup", async () => {
            const groupName = await vscode.window.showInputBox({
                prompt: "Enter group name"
            });

            if (groupName && groupName.trim()) {
                provider.addGroup(groupName.trim());
            }
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

    /* ----------------- COMMAND: DELETE REVISION TO GROUP ---------------- */
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

    /* ----------- COMMAND: OPEN ON DOUBLE CLICK (rev/file) ----------- */
    context.subscriptions.push(
        vscode.commands.registerCommand("svnRevisionManager.openOnDoubleClick", async (item) => {
            const now = Date.now();

            // double click detected
            if (item._lastClick && now - item._lastClick < 300) {

                // // If revision item
                // if (!item.isFile && !item.isGroup) {
                //     const output = await runSvnDiff(item.revision);
                //     const doc = await vscode.workspace.openTextDocument({ content: output, language: "diff" });
                //     vscode.window.showTextDocument(doc);
                // }

                // If file item
                if (item.isFile) {
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
        command = null
    }) {
        super(label, collapsibleState);

        this.revision = revision;
        this.filePath = filePath;
        this.isFile = isFile;
        this.isGroup = isGroup;
        this.groupName = groupName;

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
    const { exec } = require("child_process");

    return new Promise((resolve, reject) => {
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
    const { exec } = require("child_process");

    return new Promise((resolve, reject) => {
        exec(
            `svn diff -c ${revision} --summarize`,
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
    const { exec } = require("child_process");

    let cmd = filePath
        ? `svn diff -c ${revision} "${filePath}"`
        : `svn diff -c ${revision}`;

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

/* ------------------------------ PROVIDER -------------------------------- */

class MyTreeDataProvider {
    constructor(storageFile) {
        this.storageFile = storageFile;
        this.groups = {};
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    }

    /* ---------- Load groups & revisions from JSON ---------- */
    load() {
        if (!fs.existsSync(this.storageFile)) return;
        const data = JSON.parse(fs.readFileSync(this.storageFile, "utf8"));
        this.groups = data.groups || {};
        this.refresh();
    }

    /* ---------- Save groups ---------- */
    save() {
        fs.writeFileSync(this.storageFile, JSON.stringify({
            groups: this.groups
        }, null, 2));
    }

    /* ---------- Add group ---------- */
    addGroup(name) {
        if (!this.groups[name]) {
            this.groups[name] = [];
            this.save();
            this.refresh();
        }
    }

    /* ---------- Delete group ---------- */
    deleteGroup(name) {
        delete this.groups[name];
        this.save();
        this.refresh();
    }

    /* ---------- Rename group ---------- */
    renameGroup(oldName, newName) {
        if (!this.groups[oldName]) return;

        // Move revisions to new group name
        this.groups[newName] = this.groups[oldName];

        // Delete old group
        delete this.groups[oldName];

        this.save();
        this.refresh();
    }

    /* ---------- Add revision into group ---------- */
    async addRevisionToGroup(groupName) {
        const revision = await vscode.window.showInputBox({
            prompt: "Enter SVN revision number",
            validateInput: value => {
                if (!value || !/^\d+$/.test(value)) {
                    return "Revision must be numeric";
                }
                return null;
            }
        });

        if (!revision) return;

        // Check duplicate
        const existing = this.groups[groupName].some(
            r => String(r.revision) === String(revision)
        );

        if (existing) {
            vscode.window.showWarningMessage(
                `Revision ${revision} already exists in group "${groupName}".`
            );
            return;
        }

        // Fetch commit message
        const message = await getCommitMessage(revision);

        // Add revision
        this.groups[groupName].push({
            revision: revision,
            message: message
        });

        // SORT newest → oldest
        this.groups[groupName].sort((a, b) => Number(b.revision) - Number(a.revision));

        this.save();
        this.refresh();
    }

    /* ---------- Add revision into group ---------- */
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

    getTreeItem(element) {
        return element;
    }

    /* ---------- Build sidebar tree ---------- */
    async getChildren(element) {

        // TOP LEVEL → LIST GROUPS
        if (!element) {
            return Object.keys(this.groups).map(groupName =>
                new MyTreeItem({
                    label: groupName,
                    collapsibleState: vscode.TreeItemCollapsibleState.Collapsed,
                    isGroup: true,
                    groupName
                })
            );
        }

        // GROUP LEVEL → SHOW "+ Add Revision" + revisions
        if (element.isGroup) {
            const groupName = element.label;
            const revisions = this.groups[groupName] || [];

            revisions.sort((a, b) => Number(b.revision) - Number(a.revision));

            const children = [];

            // + ADD REVISION button
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

            // Revisions
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
        if (!element.isFile && !element.isGroup) {
            const files = await getChangedFiles(element.revision);

            return files.map(f =>
                new MyTreeItem({
                    label: f,
                    collapsibleState: vscode.TreeItemCollapsibleState.None,
                    revision: element.revision,
                    filePath: f,
                    isFile: true
                })
            );
        }

        return [];
    }

    /* ---------- generateFileList ---------- */
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

        // Create output text
        const textOutput = fileList.join("\n");

        // Open in VS Code new tab
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

function svnCat(filePath, revision) {
    const { exec } = require("child_process");

    return new Promise((resolve, reject) => {
        exec(
            `svn cat "${filePath}" -r ${revision}`,
            { cwd: getWorkingFolder(), maxBuffer: 1024 * 1024 * 10 },
            (err, stdout, stderr) => {
                if (err) {
                    resolve("");
                } else {
                    resolve(stdout);
                }
            }
        );
    });
}

function getLanguage(file) {
    if (file.endsWith(".js")) return "javascript";
    if (file.endsWith(".ts")) return "typescript";
    if (file.endsWith(".java")) return "java";
    if (file.endsWith(".jsp")) return "jsp";
    if (file.endsWith(".xml")) return "xml";
    if (file.endsWith(".css")) return "css";
    if (file.endsWith(".html")) return "html";

    return "text";
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

function deactivate() {}

module.exports = { activate, deactivate };
