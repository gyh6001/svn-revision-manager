# SVN Revision Manager

[![Visual Studio Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/GooiYinHong.svn-revision-manager)](https://marketplace.visualstudio.com/items?itemName=GooiYinHong.svn-revision-manager)
[![Visual Studio Marketplace Installs](https://img.shields.io/visual-studio-marketplace/i/GooiYinHong.svn-revision-manager)](https://marketplace.visualstudio.com/items?itemName=GooiYinHong.svn-revision-manager)
[![Visual Studio Marketplace Downloads](https://img.shields.io/visual-studio-marketplace/d/GooiYinHong.svn-revision-manager)](https://marketplace.visualstudio.com/items?itemName=GooiYinHong.svn-revision-manager)
[![Visual Studio Marketplace Rating](https://img.shields.io/visual-studio-marketplace/r/GooiYinHong.svn-revision-manager)](https://marketplace.visualstudio.com/items?itemName=GooiYinHong.svn-revision-manager)

Manage SVN revisions by organizing them into groups, viewing diffs, generating file lists, and more.

## Features

- Organize SVN revisions into groups
- View file diffs for specific revisions
- Generate consolidated file lists
- Lock/unlock files directly from VS Code
- Copy file names and paths
- Add Decorations for Locked, Modified, Unversioned, Ignored files in Explorer Tab
- Show lock owner + date time in the status bar
- **Optimized "Locked by others" loading** - lock details are fetched on demand to improve performance
- File operations: Revert, Update, and view SVN Info directly from context menus

## Screenshots

### SVN Revision Manager Sidebar
![Sidebar View](images/sidebar-screenshot.png)

### Lock Management
![Lock Management](images/right-click.png)

## Requirements

- SVN command-line tool must be installed
- Access to an SVN repository

## Extension Settings

- `svnRevisionGroup.workingFolder`: Full path to your SVN working copy folder
- `svnRevisionGroup.svnPath`: Full path to svn.exe (default: "svn")
- `svnRevisionGroup.dataPath`: Custom path to store extension data

## Usage

1. Set your SVN working folder in settings
2. Open the SVN Revision Manager sidebar
3. Create groups and add revisions
4. Right-click files to lock/unlock or perform other SVN operations
5. Right-click locked files and select **"Show Lock Info"** to view lock owner and date
6. Use the **Refresh** button in the sidebar to reload lock information

## Lock Management

| Action | Description |
|--------|-------------|
| Lock File | Lock a file with an optional message |
| Force Lock | Steal a lock from another user |
| Unlock File | Release your lock on a file |
| Show Lock Info | View lock owner and creation date (for files locked by others) |
| Refresh Locks | Reload lock information from the repository |

## File Operations

| Action | Description |
|--------|-------------|
| SVN: Revert File | Discard all local changes to a file (requires confirmation) |
| SVN: File Info | Display detailed SVN information for a file |
| SVN: Update File | Update a file to the latest repository version |

## Performance Notes

- The "Locked by me" section shows full lock details immediately
- The "Locked by others" section loads file names quickly without fetching details
- Use **"Show Lock Info"** to fetch lock owner/date on demand for better performance
- File decorations refresh automatically every 2 minutes and on save

## Tips

- All file operations are available via right-click in both the SVN Revision Manager sidebar and the Explorer
- Use the refresh button (🔄) in the sidebar to manually reload locks
- Lock information appears in the status bar when viewing files in the editor
