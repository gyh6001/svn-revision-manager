🎉 SVN Revision Group — VS Code Extension

Organize, explore, and analyze SVN revisions with style 🐉✨

Welcome to SVN Revision Group, your new best friend for managing SVN changes without leaving VS Code.
If you work with SVN every day and keep asking yourself:

“Which files changed across these revisions?”

“What did Revision 136276 actually do?”

“Can I group revisions by feature or bug ticket?”

“Can VS Code PLEASE show me this in a nice UI?”

Then this extension was made just for you. ❤️

🚀 Features (the awesome stuff)
📁 Group Your Revisions

Create groups (e.g., Bug Fixes, New Features, Hotfixes) to organize your SVN revisions.

➕ Add Revisions Into Groups

Drop in revision numbers, and the extension fetches:

Commit message

Changed file list

Revision diff

File-level diffs

✏️ Rename Groups

Because names evolve (and so do we 😌).

🗑 Delete Groups & Revisions

Clean up your view anytime.

🔍 Expand Revisions to View File Changes

Each revision expands into the full list of changed files — super handy.

🖱 Double-Click to View Diff

Double-click a revision → view full revision diff

Double-click a file → view file-specific diff

🧾 Generate File List (per Group)

Generate a consolidated list of ALL files touched across all revisions inside the group.
Duplicates? Gone.
Output appears in a clean VS Code tab.

📋 Copy Filename / Full Path

Right-click a file → copy filename or full relative path.

🗂 Persistent JSON Storage

Your groups and revisions stay exactly as they are, even after restart.

🖼 Sexy Icons for Groups

Custom icons that look great in light & dark mode.

🔢 Sorted Revisions

Automatically sorted newest → oldest.

🛠 Powered by svn diff + svn log

Everything works using your real SVN CLI — zero magic.

📸 Screenshots

(You can add yours here!)

< Coming Soon >


If you'd like, I can generate mock screenshots or styled placeholders for your Marketplace page.

🧠 How It Works

Install the extension

Open the sidebar named SVN Revision Group

Create your first group

Add revisions inside the group

Double-click to explore diffs

Right-click for actions like rename, delete, copy, or generate file list

Enjoy a clean organized view of your SVN world 🎉

🧰 Commands
Command	Action
Add Group	Create a new revision group
Add Revision to Group	Insert a revision number into a group
Rename Group	Rename the selected group
Delete Group	Delete the entire group and its revisions
Delete Revision	Remove just one revision
Generate File List	Get a deduped list of all changed files in the group
Copy File Name	Copies only the file name
Copy Full File Path	Copies the whole relative path
Open Revision (Double Click)	Opens full diff
Open File Diff (Double Click)	File-level diff
📦 Installation
Method 1 — From VSIX

Run:

vsce package


Then in VS Code:

Extensions → ... menu → Install from VSIX...

Method 2 — Command Palette
Ctrl + Shift + P → Extensions: Install from VSIX

Method 3 — CLI
code --install-extension svn-revision-group.vsix

🔧 Requirements

SVN CLI installed

A valid SVN working directory

VS Code 1.80+

🎯 Why I Built This

Because SVN still runs the world in many companies…
and the default tools are painful 😭

This extension takes the “ugh…” out of SVN and replaces it with:

Clean UI

Fun grouping

Fast workflows

Diff browsing

File impact summaries

It makes SVN… actually nice? 🤯